import type { ChainAsset, Corridor } from "./money.ts";

export type PayeeKind = "contractor" | "vendor" | "employee" | "agent";

/**
 * `draft` means the payee exists but is not yet verified; `blocked` means it
 * must never be paid. Only `approved` payees are payable without review.
 */
export type PayeeStatus = "draft" | "approved" | "blocked";

export type ScreeningState = "clear" | "review" | "hit";

export interface Payee {
  readonly id: string;
  readonly orgId: string;
  readonly kind: PayeeKind;
  readonly displayName: string;
  readonly email?: string;
  /** Where money lands for this payee. */
  readonly destination: ChainAsset;
  readonly address: string;
  /** Preferred route, e.g. "base:usdc>near:usdc". Used by the planner. */
  readonly preferredCorridor?: Corridor;
  readonly status: PayeeStatus;
  readonly screening: ScreeningState;
  /** 0..100, higher is riskier. Optional; absent means unscored. */
  readonly riskScore?: number;
}
