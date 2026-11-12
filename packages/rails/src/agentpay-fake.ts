import type { PayoutReceipt } from "@crewpay/domain";
import {
  AgentPayError,
  interpretSettle,
  type AgentOffers,
  type AgentPayPort,
  type AgentQuote,
  type AgentSettleResult,
  type X402Accept,
} from "./agentpay.ts";

export interface FakeAgentPayOptions {
  /** Destination base units the fake advertises per accepted origin. */
  readonly origins?: readonly { network: string; asset: string; payTo: string }[];
  /** Amount the quote demands in origin base units. Defaults to 1:1 with amountOut. */
  readonly amountIn?: bigint;
  /** Make the first settle call report pending, then settle on retry. */
  readonly pendingSettles?: number;
  /** Make settle report INCOMPLETE_DEPOSIT until a top-up retry. */
  readonly incompleteSettles?: number;
  /** Make settle fail terminally. */
  readonly failSettles?: boolean;
  /** Make settle fail transiently (retryable). */
  readonly retryableSettles?: boolean;
  /** Omit the transaction hash from a successful settle, to test the guard. */
  readonly settleWithoutTxHash?: boolean;
  /** Fail the quote call, as an unreachable 1Click route would. */
  readonly failQuote?: boolean;
  readonly now?: () => number;
}

/**
 * In-memory facilitator for tests and local runs. It reproduces the behaviours
 * that make the payer loop hard: a quote that demands more than the nominal
 * amount, settlement that is pending before it is done, a short deposit that
 * stays retryable, and idempotency by operation token.
 *
 * It records every settle attempt so a test can prove a retry reused the same
 * token instead of opening a second deposit.
 */
export class FakeAgentPay implements AgentPayPort {
  readonly name = "agentpay-fake";
  private readonly origins: readonly { network: string; asset: string; payTo: string }[];
  private readonly amountIn: bigint | undefined;
  private readonly now: () => number;
  private pendingRemaining: number;
  private incompleteRemaining: number;
  private counter = 0;
  private receipts = new Map<string, PayoutReceipt>();
  /** Every (operationToken, txHash) pair settle was called with, in order. */
  readonly settleCalls: { operationToken: string; txHash: string }[] = [];
  failSettles: boolean;
  retryableSettles: boolean;
  settleWithoutTxHash: boolean;
  failQuote: boolean;

  constructor(opts: FakeAgentPayOptions = {}) {
    this.origins = opts.origins ?? [
      { network: "eip155:8453", asset: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "" },
    ];
    this.amountIn = opts.amountIn;
    this.pendingRemaining = opts.pendingSettles ?? 0;
    this.incompleteRemaining = opts.incompleteSettles ?? 0;
    this.failSettles = opts.failSettles ?? false;
    this.retryableSettles = opts.retryableSettles ?? false;
    this.settleWithoutTxHash = opts.settleWithoutTxHash ?? false;
    this.failQuote = opts.failQuote ?? false;
    this.now = opts.now ?? (() => Date.now());
  }

  async supported(): Promise<Record<string, unknown>> {
    return {
      x402Version: 2,
      kinds: [{ scheme: "exact", network: "near-intents", extra: { paymentFlow: "upfront" } }],
    };
  }

  async offers(input: { amountOut: bigint; description?: string }): Promise<AgentOffers> {
    return {
      x402Version: 2,
      accepts: this.origins.map((o) => ({
        network: o.network,
        asset: o.asset,
        // Unquoted: no amount and no payTo until a quote is minted.
        payTo: o.payTo,
        amount: "",
        extra: { destination: "near:mainnet", amountOut: input.amountOut.toString() },
      })),
    };
  }

  async quote(input: { offer: X402Accept; refundTo: string }): Promise<AgentQuote> {
    if (this.failQuote) {
      throw new AgentPayError(400, "invalid_exact_near_intents_quote_unavailable", "no route");
    }
    if (!input.refundTo) {
      throw new AgentPayError(400, "refund_address_required", "refundTo is required");
    }
    const token = `op_${++this.counter}`;
    const amountOut = BigInt(String((input.offer.extra ?? {})["amountOut"] ?? "0"));
    return {
      operationToken: token,
      depositAddress: `0xdeposit_${token}`,
      amountIn: this.amountIn ?? amountOut,
      network: input.offer.network,
      asset: input.offer.asset,
      refundDeadline: new Date(this.now() + 900_000).toISOString(),
    };
  }

  async settle(input: { quote: AgentQuote; txHash: string }): Promise<AgentSettleResult> {
    const token = input.quote.operationToken;
    this.settleCalls.push({ operationToken: token, txHash: input.txHash });

    // Idempotency first: a consumed challenge returns its prior receipt, which
    // is what makes a retried settle safe.
    const existing = this.receipts.get(token);
    if (existing) return { status: "settled", receipt: existing };

    if (this.failSettles) return { status: "failed", reason: "terminal failure", retryable: false };
    if (this.retryableSettles) return { status: "failed", reason: "transient", retryable: true };
    if (this.incompleteRemaining > 0) {
      this.incompleteRemaining -= 1;
      return { status: "incomplete", reason: "deposit short", depositAddress: input.quote.depositAddress };
    }
    if (this.pendingRemaining > 0) {
      this.pendingRemaining -= 1;
      return { status: "pending", reason: "settling" };
    }
    if (this.settleWithoutTxHash) {
      // Route through the real interpreter so the guard under test is the one
      // that runs in production.
      return interpretSettle(200, { success: true, network: "near:mainnet" }, input.quote);
    }
    const receipt: PayoutReceipt = {
      operationToken: token,
      depositAddress: input.quote.depositAddress,
      amountIn: input.quote.amountIn,
      txHash: input.txHash,
      network: "near:mainnet",
      settledAt: new Date(this.now()).toISOString(),
    };
    this.receipts.set(token, receipt);
    return { status: "settled", receipt };
  }
}
