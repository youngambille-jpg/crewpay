import type { Operation } from "@crewpay/domain";
import type { DepositProof, Quote, SettlementRail, SettlementResult } from "./settlement.ts";

export interface FakeRailOptions {
  /** Operations with these ids fail at poll time, to exercise the sad path. */
  readonly failOperationIds?: readonly string[];
  /** Operations with these ids settle only after one pending poll. */
  readonly slowOperationIds?: readonly string[];
  /** Operations with these ids come back refunded. */
  readonly refundOperationIds?: readonly string[];
  /** Flat fee in basis points taken from the input side. */
  readonly feeBps?: number;
  /** Number of pending polls before a slow operation settles. */
  readonly pendingPolls?: number;
  /**
   * An explicit poll result per operation id, for reconciliation tests. Without
   * it, polling an operation the rail never submitted to still reports settled —
   * fine for the happy path, but a reconciliation test must be able to say the
   * rail has *not* settled, or it would pass without exercising that branch.
   */
  readonly pollStates?: Readonly<Record<string, SettlementResult>>;
}

/**
 * In-memory settlement used by tests and local runs. It mimics the 1Click
 * lifecycle (quote -> submit -> poll) without touching the network, so the
 * agent's money logic can be tested end to end and deterministically.
 */
export class FakeRail implements SettlementRail {
  readonly name = "fake";
  private readonly quotes = new Map<string, Quote>();
  private readonly pending = new Map<string, number>();
  private readonly fail: ReadonlySet<string>;
  private readonly slow: ReadonlySet<string>;
  private readonly refund: ReadonlySet<string>;
  private readonly feeBps: number;
  private readonly pendingPolls: number;
  private readonly pollStates: Readonly<Record<string, SettlementResult>>;

  constructor(options: FakeRailOptions = {}) {
    this.fail = new Set(options.failOperationIds ?? []);
    this.slow = new Set(options.slowOperationIds ?? []);
    this.refund = new Set(options.refundOperationIds ?? []);
    this.feeBps = options.feeBps ?? 0;
    this.pendingPolls = options.pendingPolls ?? 1;
    this.pollStates = options.pollStates ?? {};
  }

  async quote(op: Operation): Promise<Quote> {
    const feeIn = (op.amount.amount * BigInt(this.feeBps)) / 10_000n;
    const amountIn = op.amount.amount + feeIn;
    const quote: Quote = {
      quoteId: `q_${op.id}`,
      amountIn,
      minAmountIn: (amountIn * 99n) / 100n,
      amountOut: op.amount.amount,
      minAmountOut: op.amount.amount,
      feeIn,
      depositAddress: `deposit_${op.id}`,
      deadline: op.deadline,
      evidence: `fake-signature:${op.id}`,
    };
    this.quotes.set(op.id, quote);
    return quote;
  }

  async submit(op: Operation, quote: Quote, _proof?: DepositProof): Promise<SettlementResult> {
    if (this.fail.has(op.id)) {
      return { operationId: op.id, status: "failed", quoteId: quote.quoteId, failureReason: "injected failure" };
    }
    if (this.refund.has(op.id)) {
      return { operationId: op.id, status: "refunded", quoteId: quote.quoteId, failureReason: "PARTIAL_DEPOSIT" };
    }
    if (this.slow.has(op.id)) {
      this.pending.set(op.id, this.pendingPolls);
      return { operationId: op.id, status: "pending", quoteId: quote.quoteId };
    }
    return this.settled(op.id, quote.quoteId);
  }

  async poll(operationId: string, quote?: Quote): Promise<SettlementResult> {
    const explicit = this.pollStates[operationId];
    if (explicit) return explicit;
    const remaining = this.pending.get(operationId);
    if (remaining !== undefined) {
      if (remaining > 1) {
        this.pending.set(operationId, remaining - 1);
        return { operationId, status: "pending", quoteId: quote?.quoteId ?? `q_${operationId}` };
      }
      this.pending.delete(operationId);
      return this.settled(operationId, quote?.quoteId ?? this.quotes.get(operationId)?.quoteId);
    }
    return this.settled(operationId, quote?.quoteId);
  }

  private settled(operationId: string, quoteId: string | undefined): SettlementResult {
    return {
      operationId,
      status: "settled",
      ...(quoteId ? { quoteId } : {}),
      txHash: `tx_${operationId}`,
      evidence: `fake:${operationId}`,
    };
  }
}
