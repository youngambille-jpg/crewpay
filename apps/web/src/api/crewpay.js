/**
 * Typed-by-convention access to the CrewPay control plane.
 *
 * Reads and writes go through same-origin server functions (`apiGet`/`apiPost`
 * in `./api.server.js`), which attach the API bearer token server-side — the
 * browser never holds a credential.
 *
 * Money rules, mirrored from the server: USD crosses the wire as integer
 * cents; on-chain amounts are strings (serialised bigint) and are never
 * `Number()`-ed for display logic.
 *
 * This module is dependency-free on purpose: the mapping contract below is
 * covered by `crewpay.test.js`, which runs under plain `node --test`.
 */

export const ORG_ID = "org_1";

/**
 * Server payee -> UI row. Spreads every server field through (so a later
 * upsert can rebuild the exact record) and adds the display aliases the
 * table and forms read.
 */
export function toUiPayee(p) {
  return {
    ...p,
    name: p.displayName,
    payee_ref: p.id,
    chain: p.destination.chain,
    asset: p.destination.asset,
    // null, not 0, when unscored: nothing currently produces a score, and a
    // zero would render as a passing risk check that never ran.
    risk_score: typeof p.riskScore === "number" ? p.riskScore : null,
  };
}

/** UI row -> exact server record for a status-change upsert. No alias leaks. */
export function toServerPayee(ui) {
  const record = {
    id: ui.id,
    kind: ui.kind,
    displayName: ui.displayName,
    destination: ui.destination,
    address: ui.address,
    status: ui.status,
    screening: ui.screening,
  };
  if (ui.email) record.email = ui.email;
  if (typeof ui.riskScore === "number") record.riskScore = ui.riskScore;
  return record;
}

/** New-payee payload from form fields. Draft + review: never self-approved. */
export function newPayeePayload({ id, kind, displayName, name, chain, asset, address }) {
  return {
    id: id.trim(),
    kind,
    displayName: (displayName ?? name ?? "").trim(),
    destination: { chain: chain.trim(), asset: asset.trim().toLowerCase() },
    address: address.trim(),
    status: "draft",
    screening: "review",
  };
}

/**
 * On-chain base units -> USD cents. The loop mints each operation's amount as
 * `BigInt(usdCents) * 10_000n`, so the inverse is exact and safe to display.
 * Returns 0 for a missing or unparseable value rather than NaN.
 */
function usdCentsFromBaseUnits(baseUnits) {
  try {
    return Number(BigInt(baseUnits ?? "0") / 10_000n);
  } catch {
    return 0;
  }
}

/** The run id an operation belongs to, from `run_1_op_2` -> `run_1`. */
function runIdFromOperation(operationId) {
  if (typeof operationId !== "string") return "";
  const at = operationId.indexOf("_op_");
  return at > 0 ? operationId.slice(0, at) : operationId;
}

const FUNDING_KIND_LABEL = {
  pending: "Pending",
  needs_review: "Needs review",
  failed: "Failed",
};

/**
 * Server pay run (with its `items`) -> UI row. The counts and the batch value
 * are derived from the lines, not stored: the API returns lines, and a stored
 * total would be a second source of truth that can drift from them.
 */
export function toUiPayRun(run) {
  const items = Array.isArray(run.items) ? run.items : [];
  const countOf = (state) => items.filter((item) => item.state === state).length;
  const totalCents = items.reduce(
    (sum, item) => sum + usdCentsFromBaseUnits(item.amount?.amount),
    0,
  );
  return {
    ...run,
    run_ref: run.id,
    created_date: run.createdAt,
    line_count: items.length,
    total_cents: totalCents,
    settled_count: countOf("settled"),
    held_count: countOf("awaiting_approval"),
    denied_count: countOf("denied"),
  };
}

/**
 * One `/v1/operations` row -> UI line. The row is `{operation, record, receipt}`:
 * the operation is the proposed movement, the record is what the policy decided
 * and what happened, the receipt is the on-chain evidence. The decision and the
 * tx hash come from the record, never re-derived here.
 */
export function toUiPayRunLine(row, payeeNames) {
  const operation = row.operation ?? {};
  const record = row.record ?? {};
  const receipt = row.receipt ?? {};
  return {
    ...row,
    id: operation.id ?? record.operationId,
    run_id: record.payRunId,
    payee_id: record.payeeId,
    payee_name: payeeNames?.get(record.payeeId) ?? record.payeeId ?? "—",
    amount_cents: operation.usdCents ?? 0,
    decision: record.decision,
    reason_codes: record.reasonCodes ?? [],
    status: record.status ?? "pending",
    note: record.note,
    tx_hash: record.txHash ?? receipt.txHash,
  };
}

/**
 * Server approval -> UI row. The amount is the frozen operation's USD
 * valuation, not a live one: the approver signs off on the operation as it was
 * evaluated, so the row must show that same figure.
 */
export function toUiApproval(approval, payeeNames) {
  return {
    ...approval,
    approval_ref: approval.id,
    run_ref: runIdFromOperation(approval.operation?.id ?? approval.operationId),
    payee_name: payeeNames?.get(approval.payeeId) ?? approval.payeeId,
    amount_cents: approval.operation?.usdCents ?? 0,
    reasons: approval.reasonCodes ?? [],
    created_date: approval.requestedAt,
    policy_id: approval.policyId,
    policy_version: approval.policyVersion,
  };
}

/**
 * Funding record -> UI row. `status` is the record's `kind` (the worklist chip
 * reads it); `kind` is the same value as a label. There is no `resolved` row:
 * the list excludes resolved records server-side.
 */
export function toUiWorklistItem(record) {
  return {
    ...record,
    request_ref: record.requestId,
    operation_ref: record.operationId,
    status: record.kind,
    kind: FUNDING_KIND_LABEL[record.kind] ?? record.kind,
    detail: record.resolutionNote ?? "",
    observed_state: FUNDING_KIND_LABEL[record.kind] ?? record.kind,
    created_date: record.createdAt,
  };
}

/** Server invoice -> UI row. */
export function toUiInvoice(invoice) {
  return {
    ...invoice,
    invoice_ref: invoice.id,
    customer: invoice.customerId,
    amount_cents: invoice.amount,
    created_date: invoice.createdAt,
    checkout_url: invoice.checkoutUrl,
    paid_date: invoice.paidAt,
    due_date: invoice.dueDate,
    line_items: invoice.lineItems ?? [],
    tx_hashes: invoice.txHashes ?? [],
    // The public, capability-URL pay page: the customer opens it and pays from
    // any chain into our NEAR settlement asset through NEAR Intents.
    pay_url: `/pay/${encodeURIComponent(invoice.id)}`,
  };
}

/**
 * Server testnet wallet status -> UI shape. Balances stay as base-unit strings
 * (they are serialised bigints); formatting to a decimal happens at the edge,
 * never here, so nothing rounds a balance in transit.
 */
export function toUiWallet(status) {
  return {
    ...status,
    connected: status.connected === true,
    account: status.account ?? null,
    gas_yocto: status.gasYocto ?? "0",
    usdt_base: status.usdtBase ?? "0",
  };
}

/**
 * Server funding quote -> UI shape. The preview's amounts are base-unit strings;
 * the formatted and USD figures come straight from 1Click and are shown as-is
 * rather than re-derived, so the card never claims a price 1Click did not give.
 */
export function toUiFundingQuote(quote) {
  const p = quote.preview ?? {};
  return {
    ...quote,
    simulated: quote.simulated === true,
    chain: quote.chain?.label ?? quote.chain?.chain ?? "",
    chain_id: quote.chain?.chain ?? "",
    symbol: quote.chain?.symbol ?? "",
    origin_label: `${quote.origin?.chain ?? ""}:${quote.origin?.asset ?? ""}`,
    destination_label: `${quote.destination?.chain ?? ""}:${quote.destination?.asset ?? ""}`,
    amount_in: p.amountIn ?? "0",
    amount_in_display: p.amountInFormatted ?? "",
    amount_in_usd: p.amountInUsd ?? "",
    amount_out: p.amountOut ?? "0",
    amount_out_display: p.amountOutFormatted ?? "",
    amount_out_usd: p.amountOutUsd ?? "",
    fee: p.withdrawFee ?? "0",
    refund_fee: p.refundFee ?? "0",
    time_estimate: typeof p.timeEstimate === "number" ? p.timeEstimate : null,
    deadline: p.deadline ?? "",
  };
}

/**
 * Server policy -> UI shape. The rules travel through untouched (they are
 * already integer cents) so the editor can round-trip them; the aliases are
 * display-only and never sent back.
 */
export function toUiPolicy(policy) {
  return {
    ...policy,
    policy_ref: policy.id,
    rules: policy.rules ?? {},
  };
}

/**
 * The rules a new org starts with, mirroring `defaultRules()` in
 * `packages/domain/src/policy.ts`. The web app never imports the domain package
 * — every shape it needs is re-declared here — so this is the one place the
 * defaults live client-side. The editor seeds from these when no policy exists
 * yet, so publishing v1 sends real caps rather than an empty object.
 */
export const DEFAULT_RULES = {
  maxPerTransactionCents: 500_000,
  maxDailyCents: 5_000_000,
  approvalThresholdCents: 200_000,
  allowedPayeeKinds: ["contractor", "vendor", "employee", "agent"],
  allowedCorridors: [],
  allowedAssets: ["usdc", "usdt", "dai"],
  requireApprovalForNewPayee: true,
};

/**
 * UI rules -> the exact body `POST /v1/policies` expects. The server bumps the
 * version itself, so a caller must never send one: publishing a new version is
 * what makes every decision replayable against the rules that were in force.
 */
export function toServerPolicy(rules) {
  return { orgId: ORG_ID, rules: { ...rules } };
}

/**
 * Server manifest view -> UI shape. `compileManifest` omits `limits.daily` and
 * `multisig.approval_above` when the rules do not carry them, so those read as
 * `null` rather than `""`; an absent cap must not render as a `$0.00` limit.
 * `drift` is present only when a custody signer could read the wallet's own
 * policy, and is `null` (not `[]`) when there is nothing to compare against.
 */
export function toUiManifest(view) {
  const m = view.manifest ?? {};
  return {
    ...view,
    policy_ref: view.policyId,
    policy_version: view.policyVersion,
    per_transaction: m.limits?.per_transaction ?? null,
    daily: m.limits?.daily ?? null,
    approval_above: m.multisig?.approval_above ?? null,
    approvers: m.multisig?.approvers ?? [],
    threshold: typeof m.multisig?.threshold === "number" ? m.multisig.threshold : 0,
    tokens: m.tokens?.allowed ?? [],
    chains: m.chains?.allowed ?? [],
    transaction_types: m.transaction_types ?? [],
    warnings: view.warnings ?? [],
    drift: view.drift ?? null,
  };
}

/**
 * Server ledger -> UI shape. Amounts stay base-unit strings (they are
 * serialised bigints) and are never `Number()`-ed: the books are exact, and a
 * float would silently round a figure an accountant is meant to reconcile.
 * `unbalancedCurrencies` is present only when the export is refused.
 */
export function toUiLedger(ledger) {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const trialBalance = Array.isArray(ledger.trialBalance) ? ledger.trialBalance : [];
  return {
    ...ledger,
    entries: entries.map((entry) => ({
      ...entry,
      postings: (entry.postings ?? []).map((p) => ({ ...p, amount: String(p.amount) })),
    })),
    trialBalance: trialBalance.map((row) => ({
      ...row,
      debit: String(row.debit ?? "0"),
      credit: String(row.credit ?? "0"),
      balance: String(row.balance ?? "0"),
    })),
    balanced: ledger.balanced === true,
    attestation: ledger.attestation ?? "",
    entryCount: typeof ledger.entryCount === "number" ? ledger.entryCount : entries.length,
    accountCount: trialBalance.length,
    unbalancedCurrencies: ledger.unbalancedCurrencies ?? null,
  };
}
