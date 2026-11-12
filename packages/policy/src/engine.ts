import type { Operation, Payee, Policy, UsdCents } from "@crewpay/domain";

export type Decision = "allow" | "allow_with_approval" | "deny";

export type ReasonCode =
  | "PAYEE_UNKNOWN"
  | "PAYEE_BLOCKED"
  | "PAYEE_NOT_APPROVED"
  | "PAYEE_KIND"
  | "SCREENING_HIT"
  | "SCREENING_REVIEW"
  | "RISK_SCORE"
  | "CORRIDOR_NOT_ALLOWED"
  | "ASSET_NOT_ALLOWED"
  | "PER_TX_CAP"
  | "PER_KIND_CAP"
  | "DAILY_CAP"
  | "SCHEDULE"
  | "APPROVAL_THRESHOLD"
  | "NEW_PAYEE";

export interface Reason {
  readonly code: ReasonCode;
  readonly detail: string;
}

export interface DecisionContext {
  /** The payee record, or undefined when the recipient is unknown. */
  readonly payee: Payee | undefined;
  /** USD cents already committed today, excluding this operation. */
  readonly spentTodayCents: UsdCents;
  /** True once the payee has settled at least one payment before. */
  readonly payeeHasHistory: boolean;
  /** Hour of day (0-23) in the org's timezone. */
  readonly hour: number;
}

export interface DecisionResult {
  readonly decision: Decision;
  readonly reasons: readonly Reason[];
  readonly policyId: string;
  readonly policyVersion: number;
}

function withinWindow(hour: number, fromHour: number, toHour: number): boolean {
  if (fromHour === toHour) return true;
  if (fromHour < toHour) return hour >= fromHour && hour < toHour;
  // Overnight window, e.g. 22 -> 06.
  return hour >= fromHour || hour < toHour;
}

/**
 * Deterministic evaluation of one operation against one policy version.
 * Pure and side-effect free: the same inputs always produce the same decision,
 * which is what makes the audit trail replayable.
 */
export function evaluate(
  op: Operation,
  policy: Policy,
  ctx: DecisionContext,
): DecisionResult {
  const rules = policy.rules;
  const denials: Reason[] = [];
  const approvals: Reason[] = [];
  const payee = ctx.payee;

  if (!payee) {
    denials.push({
      code: "PAYEE_UNKNOWN",
      detail: `no payee record for recipient ${op.recipient}`,
    });
  } else {
    if (payee.status === "blocked") {
      denials.push({ code: "PAYEE_BLOCKED", detail: `${payee.id} is blocked` });
    } else if (payee.status !== "approved") {
      approvals.push({
        code: "PAYEE_NOT_APPROVED",
        detail: `${payee.id} is ${payee.status}`,
      });
    }

    if (payee.screening === "hit") {
      denials.push({ code: "SCREENING_HIT", detail: `${payee.id} failed screening` });
    } else if (payee.screening === "review") {
      approvals.push({ code: "SCREENING_REVIEW", detail: `${payee.id} needs screening review` });
    }

    if (!rules.allowedPayeeKinds.includes(payee.kind)) {
      denials.push({
        code: "PAYEE_KIND",
        detail: `kind ${payee.kind} is not permitted by this policy`,
      });
    }

    if (
      rules.maxPayeeRiskScore !== undefined &&
      payee.riskScore !== undefined &&
      payee.riskScore >= rules.maxPayeeRiskScore
    ) {
      denials.push({
        code: "RISK_SCORE",
        detail: `risk ${payee.riskScore} >= max ${rules.maxPayeeRiskScore}`,
      });
    }
  }

  if (rules.allowedCorridors.length > 0 && !rules.allowedCorridors.includes(op.corridor)) {
    denials.push({ code: "CORRIDOR_NOT_ALLOWED", detail: op.corridor });
  }

  if (!rules.allowedAssets.includes(op.destination.asset)) {
    denials.push({ code: "ASSET_NOT_ALLOWED", detail: op.destination.asset });
  }

  if (op.usdCents > rules.maxPerTransactionCents) {
    denials.push({
      code: "PER_TX_CAP",
      detail: `${op.usdCents} > ${rules.maxPerTransactionCents}`,
    });
  }

  const kindCap = payee ? rules.perKindCents?.[payee.kind] : undefined;
  if (kindCap !== undefined && op.usdCents > kindCap) {
    denials.push({ code: "PER_KIND_CAP", detail: `${op.usdCents} > ${kindCap}` });
  }

  if (ctx.spentTodayCents + op.usdCents > rules.maxDailyCents) {
    denials.push({
      code: "DAILY_CAP",
      detail: `${ctx.spentTodayCents + op.usdCents} > ${rules.maxDailyCents}`,
    });
  }

  if (rules.schedule && !withinWindow(ctx.hour, rules.schedule.fromHour, rules.schedule.toHour)) {
    approvals.push({
      code: "SCHEDULE",
      detail: `hour ${ctx.hour} outside ${rules.schedule.fromHour}-${rules.schedule.toHour}`,
    });
  }

  if (op.usdCents > rules.approvalThresholdCents) {
    approvals.push({
      code: "APPROVAL_THRESHOLD",
      detail: `${op.usdCents} > ${rules.approvalThresholdCents}`,
    });
  }

  if (rules.requireApprovalForNewPayee && !ctx.payeeHasHistory) {
    approvals.push({ code: "NEW_PAYEE", detail: "no prior settled payment" });
  }

  const decision: Decision =
    denials.length > 0 ? "deny" : approvals.length > 0 ? "allow_with_approval" : "allow";

  return {
    decision,
    reasons: [...denials, ...approvals],
    policyId: policy.id,
    policyVersion: policy.version,
  };
}

export function isPayable(result: DecisionResult): boolean {
  return result.decision !== "deny";
}
