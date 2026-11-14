import { apiList, apiPost, apiCsv } from "@/api/server-calls";
import {
  newPayeePayload,
  toServerPayee,
  toUiFundingQuote,
  toUiInvoice,
  toUiLedger,
  toUiManifest,
  toUiPayee,
  toUiPayRun,
  toUiPolicy,
  toUiWallet,
} from "@/api/crewpay";

/** Onboard a payee: always draft + in review, never self-approved. */
export async function createPayee(data) {
  const created = await apiPost("/v1/payees", { orgId: "org_1", ...newPayeePayload(data) });
  return toUiPayee(created);
}

/**
 * Approve or block a payee via upsert: the API replaces the stored record, so
 * the full existing row travels back with only status/screening changed.
 */
export async function setPayeeStatus(payee, status) {
  const updated = await apiPost("/v1/payees", {
    orgId: "org_1",
    ...toServerPayee(payee),
    status,
    screening: status === "approved" ? "clear" : payee.screening,
  });
  return toUiPayee(updated);
}

/**
 * Compose and run a pay run. The API decides every line server-side (settle,
 * hold, or deny) and returns the run with its lines, so we re-read the run
 * rather than trusting the summary counts in the response.
 *
 * `origin` is the chain+asset the payroll is funded from. It is required here:
 * the server defaults to base:usdc, but a testnet deployment can only settle
 * the corridors it has mock assets for, so an omitted origin silently dooms
 * every line at execution time.
 */
export async function createPayRun({ period, source, origin, lines }) {
  const result = await apiPost("/v1/pay-runs", {
    orgId: "org_1",
    period,
    source,
    ...(origin ? { origin } : {}),
    lines: lines.map((line) => ({ payeeId: line.payee.id, usdCents: line.amount_cents })),
  });
  const runs = await apiList("/v1/pay-runs");
  const created = runs.find((run) => run.id === result.run.id);
  return toUiPayRun(created ?? { ...result.run, items: [] });
}

/**
 * Approve, reject or execute one approval. Approve and execute are separate
 * server steps on purpose: approval clears the human gate, execution re-checks
 * the current policy before any money moves.
 */
export async function decideApproval(approval, action, decidedBy = "operator") {
  return apiPost(`/v1/approvals/${encodeURIComponent(approval.id)}/${action}`, {
    decidedBy,
  });
}

/**
 * Re-read one funding request. Read-only by design: the API refuses a retry and
 * never re-submits, because a second submit could move the same money twice.
 * `resolved: false` ("still open") is a normal outcome, not an error.
 */
export async function resolveFunding(item) {
  return apiPost(`/v1/custody/requests/${encodeURIComponent(item.requestId)}/resolve`, {});
}

/**
 * Issue an invoice against the Ping checkout. The API returns the hosted
 * checkout URL, which the table links to — a link shown once in a toast would
 * be a link the operator cannot return to.
 *
 * `lineItems` (optional) are `{ description, quantity, unitAmount }` in cents
 * and must sum to `amount_cents`; the API refuses a mismatch rather than
 * storing a total that disagrees with its own breakdown.
 */
export async function createInvoice({ customer, amount_cents, payee, lineItems, dueDate }) {
  const created = await apiPost("/v1/invoices", {
    orgId: "org_1",
    customerId: customer,
    amount: amount_cents,
    ...(lineItems && lineItems.length > 0 ? { lineItems } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(payee ? { autoPayRun: { payeeId: payee.id } } : {}),
  });
  return toUiInvoice(created);
}

/**
 * Download the books as CSV. The API token lives server-side, so the text is
 * fetched through the proxy and saved in the browser as a file.
 */
export async function downloadJournalCsv() {
  const csv = await apiCsv("/v1/exports/journal.csv?orgId=org_1");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "crewpay-journal.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Re-read the server-held testnet wallet. Never registers one: the API mints the
 * wallet at boot, so this only ever reports the real account and its real
 * on-chain balances.
 */
export async function readWallet() {
  return toUiWallet(await apiList("/v1/testnet/wallet"));
}

/** The origin chains a cross-chain deposit can be priced from. */
export async function readFundingChains() {
  return apiList("/v1/funding/chains");
}

/**
 * Mint mock USDT.e to the server-held testnet wallet. A real on-chain mint of
 * the fakes token: the wallet registers itself (storage) and calls the open
 * mint. `amountBase` is optional; the API defaults to its standard faucet
 * amount. Returns the steps and the resulting balance so the caller can show
 * what actually happened rather than assume the mint landed.
 */
export async function mintTestnet({ amountBase } = {}) {
  return apiPost("/v1/testnet/mint", amountBase ? { amountBase } : {});
}

/**
 * Price a cross-chain deposit with a real 1Click dry quote. Returns a price and
 * a fee, never a deposit address — nothing moves. The `simulated` flag the
 * server sets is carried through so the card can say so plainly.
 */
export async function quoteFunding({ chain, usdCents, recipient }) {
  return toUiFundingQuote(
    await apiPost("/v1/funding/quote", {
      chain,
      usdCents,
      ...(recipient ? { recipient } : {}),
    }),
  );
}

/**
 * The active policy. There is exactly one per org: superseded versions exist so
 * a past decision stays replayable, but they are never edited.
 */
export async function readPolicy() {
  return toUiPolicy(await apiList("/v1/policies"));
}

/**
 * Publish a new policy version. The API bumps the version and deactivates the
 * old one, so a decision can always be traced to the rules in force when it was
 * made. The approvers a manifest needs are not part of the rules, so they are
 * passed to the manifest read instead — this write only carries rules.
 */
export async function publishPolicy(rules) {
  return toUiPolicy(await apiPost("/v1/policies", { orgId: "org_1", rules }));
}

/**
 * The compiled custody manifest and, when a custody signer is present, the
 * drift between our intent and the wallet's own policy. Approvers are named by
 * the caller because OutLayer's multisig approvers are wallet-owner accounts,
 * not part of Crewpay's rules.
 */
export async function readManifest({ approvers = [], threshold } = {}) {
  const query = new URLSearchParams();
  if (approvers.length) query.set("approvers", approvers.join(","));
  if (typeof threshold === "number") query.set("threshold", String(threshold));
  const suffix = query.toString() ? `?${query}` : "";
  return toUiManifest(await apiList(`/v1/manifest${suffix}`));
}

/**
 * The books: entries, a trial balance that must net to zero per currency, and a
 * content hash pinning the export to an exact set of entries. The API refuses
 * to report an unbalanced ledger rather than hand back books it cannot vouch
 * for, so an error here is a real integrity failure, not a fetch problem.
 */
export async function readLedger() {
  return toUiLedger(await apiList("/v1/ledger"));
}
