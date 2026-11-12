import type { PolicyRules, UsdCents } from "@crewpay/domain";

/**
 * Crewpay's policy rules compiled into the shape OutLayer's wallet policy
 * engine understands. Field names follow the documented policy types
 * (spending limits, address rules, allowed tokens, transaction types, time
 * restrictions, multisig, capability toggles).
 *
 * This is Crewpay's *proposal*, not a document it can install. OutLayer policy
 * is authored by the wallet's owner in the dashboard (`/wallet?key=`), and
 * there is no agent endpoint that writes it — deliberately, since the party
 * being limited should not be the party that sets the limit. So the compiled
 * manifest is (a) what we hand the owner to approve, and (b) the record we diff
 * the wallet's *effective* policy against at runtime.
 */
export interface OutLayerPolicyManifest {
  /** Transaction types the wallet may perform. Anything absent is denied. */
  readonly transaction_types: readonly string[];
  readonly addresses: {
    readonly mode: "whitelist" | "blacklist" | "none";
    readonly list: readonly string[];
  };
  readonly tokens: { readonly allowed: readonly string[] };
  /** Destination chains the wallet may bridge to. */
  readonly chains: { readonly allowed: readonly string[] };
  /** Spending limits in USD, as decimal strings (minimal units are the unit). */
  readonly limits: {
    readonly per_transaction?: string;
    readonly daily?: string;
  };
  /** Multisig: any operation at or above `approval_above` needs the votes. */
  readonly multisig: {
    readonly approvers: readonly string[];
    readonly threshold: number;
    readonly approval_above?: string;
  };
  readonly time_restrictions?: {
    readonly from_hour: number;
    readonly to_hour: number;
    readonly timezone: string;
  };
  /**
   * Capability toggles. Every one of these is default-DENY in OutLayer, so the
   * manifest has to state them explicitly. Crewpay's custody wallet needs to
   * fund deposits and nothing else, so signing raw transactions is off: a
   * compromise of the agent then cannot extract arbitrary signatures.
   */
  readonly capabilities: {
    readonly intents_withdraw: boolean;
    readonly intents_transfer: boolean;
    readonly call: boolean;
    readonly swap: boolean;
    readonly cross_chain_withdraw: boolean;
    readonly limit_order: boolean;
    readonly payment_check: boolean;
    readonly raw_sign: { readonly allowed: boolean; readonly chains: readonly string[] };
    readonly evm_sign: { readonly allowed: boolean; readonly raw_tx: boolean };
    readonly solana_sign: { readonly allowed: boolean; readonly raw_tx: boolean };
    /** Always false: a call to intents.near can add a key that signs outside the TEE. */
    readonly intents_call: false;
  };
}

export type ManifestWarningCode =
  | "NEW_PAYEE_APPROVAL"
  | "RISK_SCORE"
  | "PAYEE_KIND"
  | "NO_APPROVERS";

export interface ManifestWarning {
  readonly code: ManifestWarningCode;
  readonly detail: string;
}

export interface CompiledManifest {
  readonly manifest: OutLayerPolicyManifest;
  /**
   * Rules OutLayer cannot express. These keep their protection in Crewpay's own
   * engine, which runs first, but the manifest does not carry them — so they
   * are reported rather than silently dropped.
   */
  readonly warnings: readonly ManifestWarning[];
}

export interface CompileOptions {
  /** OutLayer account ids that may vote on a multisig request. */
  readonly approvers?: readonly string[];
  /** Votes required. OutLayer caps a ballot at 16, so a higher threshold cannot be met. */
  readonly threshold?: number;
  /** The org's timezone, for the schedule window. */
  readonly timezone?: string;
  /** Payee addresses allowed as destinations. Empty means no address rule. */
  readonly payeeAddresses?: readonly string[];
}

/** OutLayer caps one ballot at 16 votes, so a threshold above that is unreachable. */
export const MAX_APPROVERS = 16;

/** USD cents to the decimal string the policy engine reads. Never a float. */
export function usdString(cents: UsdCents): string {
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/** The chains named by a corridor set, e.g. "base:usdc>near:usdc" -> base, near. */
function chainsOf(corridors: readonly string[]): string[] {
  const chains = new Set<string>();
  for (const corridor of corridors) {
    for (const side of corridor.split(">")) {
      const chain = side.split(":")[0];
      if (chain) chains.add(chain);
    }
  }
  return [...chains].sort();
}

/**
 * Compile Crewpay rules into an OutLayer manifest.
 *
 * The mapping is deliberately narrow. Where OutLayer has an equivalent it is
 * used; where it does not, the rule is reported in `warnings` and left to the
 * deterministic engine. Pretending a rule travelled when it did not would make
 * the second layer look stronger than it is.
 */
export function compileManifest(rules: PolicyRules, opts: CompileOptions = {}): CompiledManifest {
  const warnings: ManifestWarning[] = [];
  const approvers = opts.approvers ?? [];
  const threshold = opts.threshold ?? Math.min(1, approvers.length);

  if (approvers.length === 0) {
    warnings.push({
      code: "NO_APPROVERS",
      detail: "no approvers configured; multisig cannot be enforced on-chain",
    });
  }
  if (approvers.length > MAX_APPROVERS) {
    warnings.push({
      code: "NO_APPROVERS",
      detail: `${approvers.length} approvers exceeds OutLayer's cap of ${MAX_APPROVERS}`,
    });
  }
  if (rules.requireApprovalForNewPayee) {
    warnings.push({
      code: "NEW_PAYEE_APPROVAL",
      detail: "OutLayer has no payee-history concept; enforced by the local engine only",
    });
  }
  if (rules.maxPayeeRiskScore !== undefined) {
    warnings.push({
      code: "RISK_SCORE",
      detail: "OutLayer does not score payees; enforced by the local engine only",
    });
  }
  if (rules.allowedPayeeKinds.length < 4) {
    warnings.push({
      code: "PAYEE_KIND",
      detail: `OutLayer does not model payee kinds; ${rules.allowedPayeeKinds.join(",")} enforced locally only`,
    });
  }

  const manifest: OutLayerPolicyManifest = {
    // The minimum a custody wallet needs to fund a deposit: a gasless intents
    // withdraw, an intents transfer, and an ft_transfer call. Nothing else.
    transaction_types: ["intents_withdraw", "intents_transfer", "call", "transfer"],
    addresses:
      opts.payeeAddresses && opts.payeeAddresses.length > 0
        ? { mode: "whitelist", list: [...opts.payeeAddresses] }
        : { mode: "none", list: [] },
    tokens: { allowed: [...rules.allowedAssets] },
    chains: { allowed: chainsOf(rules.allowedCorridors) },
    limits: {
      per_transaction: usdString(rules.maxPerTransactionCents),
      daily: usdString(rules.maxDailyCents),
    },
    multisig: {
      approvers: [...approvers],
      threshold,
      approval_above: usdString(rules.approvalThresholdCents),
    },
    ...(rules.schedule
      ? {
          time_restrictions: {
            from_hour: rules.schedule.fromHour,
            to_hour: rules.schedule.toHour,
            timezone: opts.timezone ?? "UTC",
          },
        }
      : {}),
    capabilities: {
      intents_withdraw: true,
      intents_transfer: true,
      call: true,
      swap: false,
      cross_chain_withdraw: false,
      limit_order: false,
      payment_check: false,
      raw_sign: { allowed: false, chains: [] },
      evm_sign: { allowed: false, raw_tx: false },
      solana_sign: { allowed: false, raw_tx: false },
      intents_call: false,
    },
  };

  return { manifest, warnings };
}

export interface ManifestDrift {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Compare the manifest we proposed with the policy the wallet actually has.
 *
 * The effective policy is the one that governs money, and it is authored by the
 * owner, so the two can differ. A drift is reported, never corrected: silently
 * rewriting the owner's policy would defeat the point of it being theirs.
 *
 * A wallet with no policy set answers with an empty or partial object, so every
 * read is optional. A field the wallet does not carry counts as absent — which
 * is itself a drift, since an absent limit is not the limit we proposed.
 */
export function diffManifest(
  expected: OutLayerPolicyManifest,
  actual: Partial<OutLayerPolicyManifest> | Record<string, unknown>,
): ManifestDrift[] {
  const drift: ManifestDrift[] = [];
  const compare = (field: string, a: unknown, b: unknown) => {
    const left = JSON.stringify(a ?? null);
    const right = JSON.stringify(b ?? null);
    if (left !== right) drift.push({ field, expected: left, actual: right });
  };

  const limits = (actual["limits"] ?? {}) as Record<string, unknown>;
  const multisig = (actual["multisig"] ?? {}) as Record<string, unknown>;
  const tokens = (actual["tokens"] ?? {}) as Record<string, unknown>;
  const chains = (actual["chains"] ?? {}) as Record<string, unknown>;

  compare("limits.per_transaction", expected.limits.per_transaction, limits["per_transaction"]);
  compare("limits.daily", expected.limits.daily, limits["daily"]);
  compare("multisig.approval_above", expected.multisig.approval_above, multisig["approval_above"]);
  compare("multisig.threshold", expected.multisig.threshold, multisig["threshold"]);
  compare("tokens.allowed", expected.tokens.allowed, tokens["allowed"]);
  compare("chains.allowed", expected.chains.allowed, chains["allowed"]);
  compare("transaction_types", expected.transaction_types, actual["transaction_types"]);
  compare("capabilities", expected.capabilities, actual["capabilities"]);

  return drift;
}
