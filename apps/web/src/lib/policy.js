// Human labels for policy reason codes. Display only: every decision is made
// server-side by the policy engine — nothing here permits or denies anything.
export const REASONS = {
  WITHIN_POLICY: "within policy",
  PAYEE_UNKNOWN: "unknown payee",
  PAYEE_BLOCKED: "payee blocked or screening hit",
  PAYEE_NOT_APPROVED: "payee not approved",
  SCREENING_REVIEW: "screening in review",
  AMOUNT_ABOVE_THRESHOLD: "amount above threshold",
  NEW_DESTINATION: "new destination",
  RAIL_TIMEOUT: "rail timeout while funding",
  UNKNOWN_STATE: "funding state unreadable",
  RECON_DRIFT: "reconciliation drift",
};

export function reasonLabels(codes) {
  return (codes ?? []).map((code) => REASONS[code] ?? String(code).toLowerCase().replaceAll("_", " "));
}
