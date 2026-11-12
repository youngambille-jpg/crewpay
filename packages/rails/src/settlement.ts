import type { Operation } from "@crewpay/domain";

/**
 * Normalised settlement state. Every rail maps its own vocabulary onto these.
 * 1Click's `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT` and
 * `PROCESSING` all collapse to `pending`; `SUCCESS` to `settled`.
 */
export type SettlementStatus =
  | "quoted"
  | "submitted"
  | "pending"
  | "settled"
  | "failed"
  | "refunded";

export interface Quote {
  /** 1Click correlation id; the handle for support and dispute resolution. */
  readonly quoteId: string;
  /** Amount the recipient receives, in destination base units. EXACT_OUTPUT. */
  readonly amountOut: bigint;
  /** Minimum output after slippage, in destination base units. */
  readonly minAmountOut: bigint;
  /** Input required, in origin base units, with slippage buffer included. */
  readonly amountIn: bigint;
  /** Minimum input accepted, in origin base units. */
  readonly minAmountIn: bigint;
  /** Fee retained by the rail from the input side, in origin base units. */
  readonly feeIn: bigint;
  readonly depositAddress: string;
  /** Required on some chains; must be echoed back when polling status. */
  readonly depositMemo?: string;
  /** ISO timestamp after which the deposit address is inactive. */
  readonly deadline: string;
  /** 1Click's signature over the quote, kept as dispute evidence. */
  readonly evidence?: string;
}

/** Proof that the deposit was broadcast, produced by the signer. */
export interface DepositProof {
  readonly txHash: string;
  /** Sender account, required only when depositing on NEAR. */
  readonly nearSenderAccount?: string;
}

export interface SettlementResult {
  readonly operationId: string;
  readonly status: SettlementStatus;
  readonly quoteId?: string;
  readonly txHash?: string;
  /** Terminal evidence: destination tx hash, intent hashes, quote signature. */
  readonly evidence?: string;
  readonly failureReason?: string;
}

export class RailError extends Error {
  readonly rail: string;
  readonly statusCode: number;

  constructor(rail: string, statusCode: number, message: string) {
    super(`${rail}: ${message}`);
    this.name = "RailError";
    this.rail = rail;
    this.statusCode = statusCode;
  }
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
  /**
   * Hand the deposit to the rail. `proof` is present when the signer has
   * already broadcast on the origin chain and the rail should be notified;
   * absent means the rail must be funded externally.
   */
  submit(op: Operation, quote: Quote, proof?: DepositProof): Promise<SettlementResult>;
  /** Poll until a terminal state or the attempt budget is exhausted. */
  poll(operationId: string, quote?: Quote): Promise<SettlementResult>;
}
