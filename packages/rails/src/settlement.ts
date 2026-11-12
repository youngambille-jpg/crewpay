import type { Operation } from "@crewpay/domain";

export type SettlementStatus =
  | "quoted"
  | "submitted"
  | "pending"
  | "settled"
  | "failed"
  | "refunded";

export interface Quote {
  readonly quoteId: string;
  /** Amount the recipient will receive, in destination smallest units. */
  readonly amountOut: bigint;
  /** Amount that must leave the origin side, in origin smallest units. */
  readonly amountIn: bigint;
  /** Fee taken from the input side, in origin smallest units. */
  readonly feeIn: bigint;
  readonly depositAddress: string;
  readonly deadline: string;
}

export interface SettlementResult {
  readonly operationId: string;
  readonly status: SettlementStatus;
  readonly quoteId?: string;
  readonly txHash?: string;
  /** Signed evidence for the ledger receipt (quote signature, tx, attestation). */
  readonly evidence?: string;
  readonly failureReason?: string;
}

/**
 * A settlement rail moves one operation from quote to terminal state. NEAR
 * Intents 1Click is the production implementation; `FakeRail` is the test and
 * local-development implementation. The agent worker only ever talks to this
 * interface, which keeps rail specifics out of the money logic.
 */
export interface SettlementRail {
  readonly name: string;
  quote(op: Operation): Promise<Quote>;
  /** Submit the deposit/authorization for a quoted operation. */
  submit(op: Operation, quote: Quote): Promise<SettlementResult>;
  /** Poll until a terminal state or the attempt budget is exhausted. */
  poll(operationId: string): Promise<SettlementResult>;
}
