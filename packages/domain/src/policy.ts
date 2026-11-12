import type { Corridor, UsdCents } from "./money.ts";

/** Rules are configuration. They are versioned so every decision is replayable. */
export interface PolicyRules {
  /** A single operation may not exceed this. */
  readonly maxPerTransactionCents: UsdCents;
  /** Rolling daily total across all operations. */
  readonly maxDailyCents: UsdCents;
  /** Operations strictly above this need a human approval. */
  readonly approvalThresholdCents: UsdCents;
  /** Payee kinds permitted at all. */
  readonly allowedPayeeKinds: readonly ("contractor" | "vendor" | "employee" | "agent")[];
  /** Corridors the agent may use. Empty means "all known corridors". */
  readonly allowedCorridors: readonly Corridor[];
  /** Assets permitted as payout destination. */
  readonly allowedAssets: readonly string[];
  /** Per-kind cap, applied on top of the global cap. */
  readonly perKindCents?: Readonly<Partial<Record<string, UsdCents>>>;
  /** If true, a payee with no prior payment history always needs approval. */
  readonly requireApprovalForNewPayee: boolean;
  /** Reject when the payee's risk score is at or above this. */
  readonly maxPayeeRiskScore?: number;
  /** Only pay between these hours in the org timezone (0-23). */
  readonly schedule?: { readonly fromHour: number; readonly toHour: number };
}

export interface Policy {
  readonly id: string;
  readonly orgId: string;
  readonly version: number;
  readonly rules: PolicyRules;
  readonly active: boolean;
}

export function defaultRules(): PolicyRules {
  return {
    maxPerTransactionCents: 500_000,
    maxDailyCents: 5_000_000,
    approvalThresholdCents: 200_000,
    allowedPayeeKinds: ["contractor", "vendor", "employee", "agent"],
    allowedCorridors: [],
    allowedAssets: ["usdc", "usdt", "dai"],
    requireApprovalForNewPayee: true,
  };
}
