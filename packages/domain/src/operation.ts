import type { ChainAsset, Corridor, Money, UsdCents } from "./money.ts";

export type OperationType =
  | "payout"
  | "agent_task_payout"
  | "treasury_convert"
  | "sweep";

export type OperationStatus =
  | "proposed"
  | "denied"
  | "awaiting_approval"
  | "approved"
  | "signing"
  | "submitted"
  | "settled"
  | "failed"
  | "refunded";

/**
 * An Operation is the unit of money movement. The agent proposes it, the policy
 * engine disposes it, and only then can the signer act on it.
 */
export interface Operation {
  readonly id: string;
  readonly orgId: string;
  readonly payRunItemId?: string;
  readonly type: OperationType;
  /** Exact amount in the origin asset's smallest unit. */
  readonly amount: Money;
  /** Valuation used for policy. */
  readonly usdCents: UsdCents;
  readonly origin: ChainAsset;
  readonly destination: ChainAsset;
  readonly corridor: Corridor;
  readonly recipient: string;
  /** Where a failed swap is refunded, on the origin chain. */
  readonly refundTo: string;
  readonly deadline: string;
}
