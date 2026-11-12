import type { Operation } from "@crewpay/domain";
import type { Quote, SettlementRail, SettlementResult } from "./settlement.ts";

export interface FakeRailOptions {
  /** Operations with these ids fail at poll time, to exercise the sad path. */
  readonly failOperationIds?: readonly string[];
  /** Operations with these ids settle only after one pending poll. */
  readonly slowOperationIds?: readonly string[];
  /** Flat fee in basis points taken from the input side. */
  readonly feeBps?: number;
}

/**
 * In-memory settlement used by tests and local runs. It mimics the 1Click
 * lifecycle (quote -> submit -> poll) without touching the network, so the
 * agent's money logic can be tested end to end and deterministically.
 */
export class FakeRail implements SettlementRail {
  readonly name = "fake";
  private readonly quotes = new Map<string, Quote>();
  private readonly pending = new Map<string, SettlementResult>();
  private readonly fail: ReadonlySet<string>;
  private readonly slow: ReadonlySet<string>;
  private readonly feeBps: number;

  constructor(options: FakeRailOptions = {}) {
    this.fail = new Set(options.failOperationIds ?? []);
    this.slow = new Set(options.slowOperationIds ?? []);
    this.feeBps = options.feeBps ?? 0;
  }

  async quote(op: Operation): Promise<Quote> {
    const feeIn = (op.amount.amount * BigInt(this.feeBps)) / 10_000n;
    const quote: Quote = {
      quoteId: `q_${op.id}`,
      amountIn: op.amount.amount + feeIn,
      amountOut: op.amount.amount,
      feeIn,
      depositAddress: `deposit_${op.id}`,
      deadline: op.deadline,
    };
    this.quotes.set(op.id, quote);
    return quote;
  }

  async submit(op: Operation, quote: Quote): Promise<SettlementResult> {
    if (this.fail.has(op.id)) {
      return { operationId: op.id, status: "failed", quoteId: quote.quoteId, failureReason: "injected failure" };
    }
    if (this.slow.has(op.id)) {
      const pending: SettlementResult = { operationId: op.id, status: "pending", quoteId: quote.quoteId };
      this.pending.set(op.id, pending);
      return pending;
    }
    return {
      operationId: op.id,
      status: "settled",
      quoteId: quote.quoteId,
      txHash: `tx_${op.id}`,
      evidence: `fake:${quote.quoteId}`,
    };
  }

  async poll(operationId: string): Promise<SettlementResult> {
    if (this.pending.has(operationId)) {
      this.pending.delete(operationId);
      const quoteId = this.quotes.get(operationId)?.quoteId;
      return {
        operationId,
        status: "settled",
        ...(quoteId ? { quoteId } : {}),
        txHash: `tx_${operationId}`,
        evidence: `fake:${operationId}`,
      };
    }
    return { operationId, status: "settled" };
  }
}
