import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toUiPayee,
  toServerPayee,
  newPayeePayload,
  toUiPayRun,
  toUiPayRunLine,
  toUiApproval,
  toUiWorklistItem,
  toUiInvoice,
  toUiWallet,
  toUiFundingQuote,
  toUiPolicy,
  toServerPolicy,
  toUiManifest,
  toUiLedger,
} from "./crewpay.js";

const serverPayee = {
  id: "ada",
  orgId: "org_1",
  kind: "contractor",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  destination: { chain: "near", asset: "usdt" },
  address: "ada.near",
  status: "approved",
  screening: "clear",
  riskScore: 12,
};

test("server payee maps to the UI row shape", () => {
  const ui = toUiPayee(serverPayee);
  assert.equal(ui.name, "Ada Lovelace");
  assert.equal(ui.payee_ref, "ada");
  assert.equal(ui.chain, "near");
  assert.equal(ui.asset, "usdt");
  assert.equal(ui.address, "ada.near");
  assert.equal(ui.risk_score, 12);
});

test("an unscored payee reads as null, never a passing zero", () => {
  const { riskScore: _dropped, ...rest } = serverPayee;
  assert.equal(toUiPayee(rest).risk_score, null);
});

test("UI row maps back to the exact server record, with no alias leaks", () => {
  const ui = toUiPayee(serverPayee);
  assert.deepEqual(toServerPayee(ui), {
    id: "ada",
    kind: "contractor",
    displayName: "Ada Lovelace",
    destination: { chain: "near", asset: "usdt" },
    address: "ada.near",
    email: "ada@example.com",
    status: "approved",
    screening: "clear",
    riskScore: 12,
  });
});

test("optional fields stay absent rather than undefined", () => {
  const { email: _e, riskScore: _r, ...rest } = serverPayee;
  const back = toServerPayee(toUiPayee(rest));
  assert.ok(!("email" in back));
  assert.ok(!("riskScore" in back));
});

test("the form's name field maps to displayName", () => {
  const payload = newPayeePayload({
    id: "ada",
    kind: "contractor",
    name: "Ada",
    chain: "near",
    asset: "usdt",
    address: "ada.near",
  });
  assert.equal(payload.displayName, "Ada");
  assert.ok(!("name" in payload));
});

test("new payees are built draft, in review, with a lowercased asset", () => {
  assert.deepEqual(
    newPayeePayload({
      id: "  shop ",
      kind: "vendor",
      displayName: " Shop ",
      chain: "base",
      asset: "USDC",
      address: " 0xshop ",
    }),
    {
      id: "shop",
      kind: "vendor",
      displayName: "Shop",
      destination: { chain: "base", asset: "usdc" },
      address: "0xshop",
      status: "draft",
      screening: "review",
    },
  );
});

/* ----------------------------- pay runs ----------------------------- */

// The loop mints each operation's amount as BigInt(usdCents) * 10_000n.
const baseUnits = (cents) => (BigInt(cents) * 10_000n).toString();

test("a pay run's value and counts are derived from its lines", () => {
  const run = {
    id: "run_1",
    orgId: "org_1",
    source: "api",
    period: "2026-11",
    currency: "usdc",
    status: "partially_settled",
    createdBy: "api",
    createdAt: "2026-11-14T00:00:00.000Z",
    items: [
      { id: "i1", payRunId: "run_1", payeeId: "ada", amount: { amount: baseUnits(500), asset: "usdc" }, corridor: "base->near", state: "settled" },
      { id: "i2", payRunId: "run_1", payeeId: "bob", amount: { amount: baseUnits(250), asset: "usdc" }, corridor: "base->near", state: "awaiting_approval" },
      { id: "i3", payRunId: "run_1", payeeId: "cy", amount: { amount: baseUnits(125), asset: "usdc" }, corridor: "base->near", state: "denied" },
    ],
  };
  const ui = toUiPayRun(run);
  assert.equal(ui.run_ref, "run_1");
  assert.equal(ui.line_count, 3);
  assert.equal(ui.total_cents, 875);
  assert.equal(ui.settled_count, 1);
  assert.equal(ui.held_count, 1);
  assert.equal(ui.denied_count, 1);
});

test("a run with no items reports zero, not NaN", () => {
  const ui = toUiPayRun({ id: "run_9", createdAt: "2026-11-14T00:00:00.000Z", status: "draft" });
  assert.equal(ui.line_count, 0);
  assert.equal(ui.total_cents, 0);
});

test("an operation row maps to a line with its payee name and decision", () => {
  const row = {
    operation: { id: "run_1_op_2", usdCents: 250, type: "payout" },
    record: {
      operationId: "run_1_op_2",
      payRunId: "run_1",
      payeeId: "bob",
      decision: "allow_with_approval",
      reasonCodes: ["AMOUNT_ABOVE_THRESHOLD"],
      status: "awaiting_approval",
    },
  };
  const names = new Map([["bob", "Bob Stone"]]);
  const line = toUiPayRunLine(row, names);
  assert.equal(line.id, "run_1_op_2");
  assert.equal(line.run_id, "run_1");
  assert.equal(line.payee_name, "Bob Stone");
  assert.equal(line.amount_cents, 250);
  assert.equal(line.decision, "allow_with_approval");
  assert.equal(line.status, "awaiting_approval");
  assert.deepEqual(line.reason_codes, ["AMOUNT_ABOVE_THRESHOLD"]);
});

test("a settled line carries the tx hash from its receipt", () => {
  const row = {
    operation: { id: "run_1_op_1", usdCents: 500 },
    record: { operationId: "run_1_op_1", payRunId: "run_1", payeeId: "ada", status: "settled", decision: "allow" },
    receipt: { operationId: "run_1_op_1", txHash: "0xabc" },
  };
  assert.equal(toUiPayRunLine(row, new Map()).tx_hash, "0xabc");
});

test("a failed line carries the server's failure note", () => {
  const row = {
    operation: { id: "run_1_op_1", usdCents: 500 },
    record: {
      operationId: "run_1_op_1",
      payRunId: "run_1",
      payeeId: "ada",
      status: "failed",
      decision: "allow_with_approval",
      note: "chain_refused: account is not visible on the network",
    },
  };
  assert.equal(
    toUiPayRunLine(row, new Map()).note,
    "chain_refused: account is not visible on the network",
  );
});

/* ----------------------------- approvals ----------------------------- */

test("an approval shows the frozen operation's amount, not a live one", () => {
  const approval = {
    id: "apv_1",
    orgId: "org_1",
    operationId: "run_1_op_1",
    operation: { id: "run_1_op_1", usdCents: 500 },
    payeeId: "ada",
    policyId: "pol_1",
    policyVersion: 3,
    reasonCodes: ["NEW_PAYEE", "AMOUNT_ABOVE_THRESHOLD"],
    status: "pending",
    requestedBy: "api",
    requestedAt: "2026-11-14T00:00:00.000Z",
  };
  const ui = toUiApproval(approval, new Map([["ada", "Ada Lovelace"]]));
  assert.equal(ui.approval_ref, "apv_1");
  assert.equal(ui.run_ref, "run_1");
  assert.equal(ui.payee_name, "Ada Lovelace");
  assert.equal(ui.amount_cents, 500);
  assert.deepEqual(ui.reasons, ["NEW_PAYEE", "AMOUNT_ABOVE_THRESHOLD"]);
  assert.equal(ui.policy_id, "pol_1");
  assert.equal(ui.policy_version, 3);
});

/* ------------------------------ worklist ------------------------------ */

test("a funding record's status is its kind, with a readable label", () => {
  const ui = toUiWorklistItem({
    requestId: "req_1",
    orgId: "org_1",
    operationId: "run_1_op_3",
    kind: "needs_review",
    reason: "rail timeout",
    createdAt: "2026-11-14T00:00:00.000Z",
  });
  assert.equal(ui.request_ref, "req_1");
  assert.equal(ui.operation_ref, "run_1_op_3");
  assert.equal(ui.status, "needs_review");
  assert.equal(ui.kind, "Needs review");
});

test("a funding record never invents a resolved row state", () => {
  const ui = toUiWorklistItem({ requestId: "req_1", operationId: "op_1", kind: "failed", reason: "x", createdAt: "" });
  assert.equal(ui.status, "failed");
  assert.notEqual(ui.status, "resolved");
});

/* ------------------------------ invoices ------------------------------ */

test("an invoice maps to the row the table reads", () => {
  const ui = toUiInvoice({
    id: "inv_1",
    orgId: "org_1",
    customerId: "Halcyon Labs",
    amount: 129900,
    settlementAsset: { chain: "near", asset: "usdc" },
    status: "open",
    checkoutSessionId: "cs_1",
    checkoutUrl: "https://checkout.ping.xyz/cs_1",
    createdAt: "2026-11-14T00:00:00.000Z",
  });
  assert.equal(ui.invoice_ref, "inv_1");
  assert.equal(ui.customer, "Halcyon Labs");
  assert.equal(ui.amount_cents, 129900);
  assert.equal(ui.checkout_url, "https://checkout.ping.xyz/cs_1");
  assert.equal(ui.created_date, "2026-11-14T00:00:00.000Z");
});

/* ------------------------------ wallet + funding ------------------------------ */

test("a wallet status keeps balances as base-unit strings", () => {
  const ui = toUiWallet({
    connected: true,
    account: "43b130e564b41e2f8f5d5ede77dd47a241b5d9ee04cc21aae3eb038eea0822e9",
    gasYocto: "300000000000000000000000",
    usdtBase: "10000000",
  });
  assert.equal(ui.connected, true);
  assert.equal(ui.account, "43b130e564b41e2f8f5d5ede77dd47a241b5d9ee04cc21aae3eb038eea0822e9");
  // Strings in, strings out: nothing is Number()-ed on the way through.
  assert.equal(ui.gas_yocto, "300000000000000000000000");
  assert.equal(ui.usdt_base, "10000000");
});

test("a missing wallet status reads as not connected, not as a zero balance", () => {
  const ui = toUiWallet({ connected: false });
  assert.equal(ui.connected, false);
  assert.equal(ui.account, null);
  assert.equal(ui.gas_yocto, "0");
  assert.equal(ui.usdt_base, "0");
});

test("a funding quote keeps 1Click's own formatted and USD figures", () => {
  const ui = toUiFundingQuote({
    simulated: true,
    chain: { chain: "base", asset: "usdc", symbol: "USDC", label: "Base" },
    origin: { chain: "base", asset: "usdc" },
    destination: { chain: "near", asset: "usdt" },
    preview: {
      amountIn: "1014373",
      amountInFormatted: "1.014373",
      amountInUsd: "1.013961164562",
      amountOut: "1000000",
      amountOutFormatted: "1.0",
      amountOutUsd: "0.999594000000",
      withdrawFee: "4152",
      refundFee: "2400",
      timeEstimate: 35,
    },
  });
  assert.equal(ui.simulated, true);
  assert.equal(ui.chain, "Base");
  assert.equal(ui.chain_id, "base");
  assert.equal(ui.symbol, "USDC");
  assert.equal(ui.origin_label, "base:usdc");
  assert.equal(ui.destination_label, "near:usdt");
  assert.equal(ui.amount_in_display, "1.014373");
  assert.equal(ui.amount_out, "1000000");
  assert.equal(ui.fee, "4152");
  assert.equal(ui.time_estimate, 35);
});

test("a funding quote with no preview still yields a usable shape", () => {
  const ui = toUiFundingQuote({ simulated: true, chain: { chain: "eth", label: "Ethereum" } });
  assert.equal(ui.amount_in, "0");
  assert.equal(ui.amount_in_display, "");
  assert.equal(ui.time_estimate, null);
  assert.equal(ui.chain, "Ethereum");
});

/* ------------------------------ policy ------------------------------ */

const policyRules = {
  maxPerTransactionCents: 500_000,
  maxDailyCents: 5_000_000,
  approvalThresholdCents: 200_000,
  allowedPayeeKinds: ["contractor", "vendor", "employee", "agent"],
  allowedCorridors: [],
  allowedAssets: ["usdc", "usdt", "dai"],
  requireApprovalForNewPayee: true,
};

test("a policy keeps its rules as integer cents, with a display ref", () => {
  const ui = toUiPolicy({ id: "pol_3", orgId: "org_1", version: 3, active: true, rules: policyRules });
  assert.equal(ui.policy_ref, "pol_3");
  assert.equal(ui.rules.maxPerTransactionCents, 500_000);
  assert.equal(ui.rules.approvalThresholdCents, 200_000);
});

test("publishing a policy sends rules and the org, never a version", () => {
  const body = toServerPolicy(policyRules);
  assert.equal(body.orgId, "org_1");
  assert.deepEqual(body.rules, policyRules);
  // The server bumps the version; sending one would let a caller rewrite history.
  assert.ok(!("version" in body));
});

/* ------------------------------ manifest ------------------------------ */

test("a manifest reads its limits and multisig from the compiled shape", () => {
  const ui = toUiManifest({
    policyId: "pol_3",
    policyVersion: 3,
    manifest: {
      limits: { per_transaction: "5000.00", daily: "50000.00" },
      tokens: { allowed: ["usdc", "usdt"] },
      chains: { allowed: ["near", "base"] },
      multisig: { approvers: ["owner.near"], threshold: 1, approval_above: "2000.00" },
    },
    warnings: [{ code: "NEW_PAYEE_APPROVAL", detail: "enforced locally" }],
  });
  assert.equal(ui.policy_ref, "pol_3");
  assert.equal(ui.policy_version, 3);
  assert.equal(ui.per_transaction, "5000.00");
  assert.equal(ui.daily, "50000.00");
  assert.equal(ui.approval_above, "2000.00");
  assert.deepEqual(ui.approvers, ["owner.near"]);
  assert.equal(ui.threshold, 1);
  assert.deepEqual(ui.tokens, ["usdc", "usdt"]);
  assert.deepEqual(ui.chains, ["near", "base"]);
});

test("an absent cap reads as null, never as a $0.00 limit", () => {
  const ui = toUiManifest({
    policyId: "pol_1",
    policyVersion: 1,
    manifest: { limits: { per_transaction: "5000.00" }, multisig: { approvers: [], threshold: 0 } },
  });
  assert.equal(ui.per_transaction, "5000.00");
  assert.equal(ui.daily, null);
  assert.equal(ui.approval_above, null);
});

test("drift is null when there is no custody policy to diff against", () => {
  const ui = toUiManifest({ policyId: "pol_1", policyVersion: 1, manifest: {} });
  assert.equal(ui.drift, null);
  assert.deepEqual(ui.warnings, []);
});

test("drift is carried through when the wallet's policy was read", () => {
  const ui = toUiManifest({
    policyId: "pol_1",
    policyVersion: 1,
    manifest: {},
    drift: [{ field: "limits.daily", expected: "50000.00", actual: "10000.00" }],
  });
  assert.equal(ui.drift.length, 1);
  assert.equal(ui.drift[0].field, "limits.daily");
});

/* ------------------------------- ledger ------------------------------- */

test("a ledger keeps every amount as an exact string, never a float", () => {
  const ui = toUiLedger({
    orgId: "org_1",
    entries: [
      {
        id: "je_1",
        orgId: "org_1",
        kind: "payment_settled",
        memo: "payout settled",
        createdAt: "2026-11-14T00:00:00.000Z",
        postings: [
          { account: "liability:payroll_payable", direction: "debit", amount: "1000000", currency: "usdt" },
          { account: "asset:stablecoin_clearing", direction: "credit", amount: "1000000", currency: "usdt" },
        ],
      },
    ],
    trialBalance: [
      { account: "asset:stablecoin_clearing", currency: "usdt", debit: "0", credit: "1000000", balance: "-1000000" },
    ],
    balanced: true,
    attestation: "abc123",
    entryCount: 1,
  });
  assert.equal(ui.entries[0].postings[0].amount, "1000000");
  assert.equal(ui.trialBalance[0].balance, "-1000000");
  assert.equal(ui.balanced, true);
  assert.equal(ui.accountCount, 1);
  assert.equal(ui.attestation, "abc123");
});

test("a large base-unit amount survives the mapping without rounding", () => {
  // Larger than Number.MAX_SAFE_INTEGER: a float would silently lose precision.
  const big = "123456789012345678901234567890";
  const ui = toUiLedger({
    entries: [],
    trialBalance: [{ account: "asset:treasury", currency: "near", debit: big, credit: "0", balance: big }],
    balanced: true,
  });
  assert.equal(ui.trialBalance[0].debit, big);
  assert.equal(ui.trialBalance[0].balance, big);
});

test("an empty ledger reads as balanced with an attestation over nothing", () => {
  const ui = toUiLedger({
    orgId: "org_1",
    entries: [],
    trialBalance: [],
    balanced: true,
    attestation: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    entryCount: 0,
  });
  assert.equal(ui.entryCount, 0);
  assert.equal(ui.accountCount, 0);
  assert.equal(ui.balanced, true);
  assert.equal(ui.unbalancedCurrencies, null);
});

test("an unbalanced ledger names the currency rather than hiding it", () => {
  const ui = toUiLedger({ entries: [], trialBalance: [], balanced: false, unbalancedCurrencies: ["usdt"] });
  assert.equal(ui.balanced, false);
  assert.deepEqual(ui.unbalancedCurrencies, ["usdt"]);
});
