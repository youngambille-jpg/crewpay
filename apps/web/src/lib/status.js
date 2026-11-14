const TONE_CLASS = {
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
  rose: "bg-rose-50 text-rose-700 ring-rose-600/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/15",
};

const DOT_CLASS = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  indigo: "bg-indigo-500",
  slate: "bg-slate-400",
};

/**
 * Status vocabulary, keyed to the server's exact enums — not a superset.
 *
 * An earlier revision was written against a different entity model, so it
 * carried values the API never emits (`scheduled`, `processing`, `void`,
 * `pending_approval`, `unsafe_failure`, `resolved`) and lacked ones it does
 * (`awaiting_approval`, `executing`, `expired`, `cancelled`, `refunded`,
 * `proposed`, `allow`, `allow_with_approval`). Because `statusMeta` falls back
 * to a neutral chip, that mismatch rendered as grey rather than as an error.
 *
 * Sources: `packages/domain/src/{payrun,approval,invoice,operation}.ts`,
 * `packages/policy/src/engine.ts`, and `FundingRecord.kind` in
 * `apps/api/src/store.ts`. Keep this in step with those, and keep the fallback
 * returning the raw value so a new status is visibly unmapped, not silently
 * neutral.
 */
export const STATUS = {
  run: {
    draft: { label: "Draft", tone: "slate" },
    planning: { label: "Planning", tone: "indigo" },
    awaiting_approval: { label: "Awaiting approval", tone: "amber" },
    executing: { label: "Executing", tone: "indigo" },
    settled: { label: "Settled", tone: "emerald" },
    partially_settled: { label: "Partly settled", tone: "amber" },
    failed: { label: "Failed", tone: "rose" },
  },
  // OperationStatus. A pay-run line carries the operation's state, and
  // `pending` is the only extra value the loop uses before a decision lands.
  line: {
    pending: { label: "Pending", tone: "slate" },
    proposed: { label: "Proposed", tone: "slate" },
    denied: { label: "Denied", tone: "rose" },
    awaiting_approval: { label: "Held", tone: "amber" },
    approved: { label: "Approved", tone: "indigo" },
    signing: { label: "Signing", tone: "indigo" },
    submitted: { label: "Submitted", tone: "amber" },
    settled: { label: "Settled", tone: "emerald" },
    failed: { label: "Failed", tone: "rose" },
    refunded: { label: "Refunded", tone: "amber" },
  },
  // PolicyDecision. `deny` is the engine's word; `denied` is the line status.
  decision: {
    allow: { label: "Auto-settle", tone: "emerald" },
    allow_with_approval: { label: "Hold for approval", tone: "amber" },
    deny: { label: "Deny", tone: "rose" },
  },
  approval: {
    pending: { label: "Pending", tone: "amber" },
    approved: { label: "Approved", tone: "indigo" },
    rejected: { label: "Rejected", tone: "rose" },
    executing: { label: "Executing", tone: "indigo" },
    executed: { label: "Executed", tone: "emerald" },
    failed: { label: "Failed", tone: "rose" },
    stale: { label: "Stale", tone: "slate" },
  },
  payee: {
    draft: { label: "Draft", tone: "slate" },
    approved: { label: "Approved", tone: "emerald" },
    blocked: { label: "Blocked", tone: "rose" },
  },
  screening: {
    clear: { label: "Clear", tone: "emerald" },
    review: { label: "Review", tone: "amber" },
    hit: { label: "Hit", tone: "rose" },
  },
  invoice: {
    open: { label: "Open", tone: "indigo" },
    pending: { label: "Pending", tone: "amber" },
    paid: { label: "Paid", tone: "emerald" },
    expired: { label: "Expired", tone: "slate" },
    cancelled: { label: "Cancelled", tone: "slate" },
    refunded: { label: "Refunded", tone: "amber" },
    failed: { label: "Failed", tone: "rose" },
  },
  // FundingRecord.kind. There is no `resolved` row state: resolved records are
  // filtered out server-side, and "resolved" is a transient answer from the
  // resolve call, not a row.
  worklist: {
    pending: { label: "Pending", tone: "amber" },
    needs_review: { label: "Needs review", tone: "amber" },
    failed: { label: "Failed", tone: "rose" },
  },
};

export function statusMeta(kind, value) {
  return STATUS[kind]?.[value] ?? { label: value || "—", tone: "slate" };
}

/**
 * Journal entry kinds (`EntryKind` in `packages/ledger/src/journal.ts`). These
 * are not statuses — an entry is a fact, not a state — so they get a plain
 * label rather than a tone. An unknown kind falls back to the raw value with
 * underscores spaced, so a new kind is readable and visibly unmapped.
 */
export const JOURNAL_KIND = {
  payroll_accrual: "Payroll accrual",
  payment_settled: "Payment settled",
  treasury_convert: "Treasury conversion",
  fee_collected: "Fee collected",
  refund: "Refund",
  revenue: "Revenue",
};

export function journalKindLabel(kind) {
  return JOURNAL_KIND[kind] ?? String(kind ?? "—").replaceAll("_", " ");
}

/**
 * Why a rule did not make it into the custody manifest. `compileManifest`
 * reports these rather than dropping the rule silently, so the manifest never
 * looks stronger than it is. Keys are `ManifestWarningCode` in
 * `packages/signer/src/manifest.ts`.
 */
export const MANIFEST_WARNING = {
  NEW_PAYEE_APPROVAL: "New-payee approval is enforced by the local engine only — OutLayer has no payment history.",
  RISK_SCORE: "Payee risk scoring is enforced by the local engine only — OutLayer does not score payees.",
  PAYEE_KIND: "Payee-kind limits are enforced by the local engine only — OutLayer does not model payee kinds.",
  NO_APPROVERS: "No multisig approvers configured — the wallet cannot enforce a threshold on-chain.",
};

export function manifestWarningLabel(code, detail) {
  // The server's `detail` is the precise reason (it can name the exact
  // over-cap approver count); the curated line is the fallback when a code
  // arrives without one, so a warning is never blank.
  return detail || MANIFEST_WARNING[code] || String(code ?? "").replaceAll("_", " ");
}

export function toneClass(tone) {
  return TONE_CLASS[tone] ?? TONE_CLASS.slate;
}

export function dotClass(tone) {
  return DOT_CLASS[tone] ?? DOT_CLASS.slate;
}