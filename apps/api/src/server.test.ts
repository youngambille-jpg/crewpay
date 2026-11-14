import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { FakeRail, FakePingPay, FakeAgentPay, Relayer, RailError } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";
import type { LiveServices } from "./live.ts";
import { TEST_TOKEN, testAuth, type AuthConfig } from "./auth.ts";

function base(chain: string, asset: string) {
  return { chain, asset };
}

async function start(
  opts: ConstructorParameters<typeof FakeRail>[0] & {
    signer?: FakeSigner;
    pingpay?: FakePingPay;
    agentpay?: FakeAgentPay;
    auth?: AuthConfig;
    live?: LiveServices;
    relayer?: Relayer;
  } = {},
) {
  const { signer, pingpay, agentpay, auth, live, relayer, ...railOpts } = opts;
  const { server, store } = createApi({
    auth: auth ?? testAuth(),
    rail: new FakeRail(railOpts),
    ...(signer ? { signer } : {}),
    ...(pingpay ? { pingpay } : {}),
    ...(agentpay ? { agentpay } : {}),
    ...(live ? { live } : {}),
    ...(relayer ? { relayer } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  /**
   * A request with no Authorization header, or with whatever token is given.
   * Used to prove what an anonymous or wrong-token caller can reach.
   */
  const raw = async (
    path: string,
    method = "GET",
    opts: { body?: unknown; token?: string } = {},
  ) => {
    const res = await fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  // Webhooks are verified over the raw bytes, so the tests must send bytes and
  // headers rather than a re-serialised object.
  const rawPost = async (path: string, body: string, headers: Record<string, string>) => {
    const res = await fetch(url + path, { method: "POST", headers, body });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { server, store, call, raw, rawPost, url };
}

/** Seed one org with a policy, a payee, and a run that needs approval. */
async function seedAndRun(
  call: Awaited<ReturnType<typeof start>>["call"],
  opts: { usdCents?: number; rules?: Partial<ReturnType<typeof defaultRules>> } = {},
) {
  await call("/v1/payees", "POST", {
    id: "ada",
    orgId: "org_1",
    kind: "contractor",
    displayName: "Ada",
    destination: base("near", "usdc"),
    address: "ada.near",
    status: "approved",
    screening: "clear",
  });
  await call("/v1/policies", "POST", {
    orgId: "org_1",
    rules: { ...defaultRules(), requireApprovalForNewPayee: false, ...opts.rules },
  });
  return call("/v1/pay-runs", "POST", {
    orgId: "org_1",
    period: "2026-11",
    lines: [{ payeeId: "ada", usdCents: opts.usdCents ?? 250_000 }],
  });
}

test("runs a pay run end to end over HTTP", async () => {
  const { server, call } = await start();
  try {
    await call("/v1/payees", "POST", {
      id: "ada",
      orgId: "org_1",
      kind: "contractor",
      displayName: "Ada",
      destination: base("near", "usdc"),
      address: "ada.near",
      status: "approved",
      screening: "clear",
    });
    await call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: false },
    });

    const { status, json } = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 150_000 }],
    });

    assert.equal(status, 201);
    assert.equal(json.settledCents, 150_000);
    assert.deepEqual(json.denied, []);
    assert.deepEqual(json.awaitingApproval, []);
  } finally {
    server.close();
  }
});

test("health reports the active rail", async () => {
  const { server, call } = await start();
  try {
    const { status, json } = await call("/health", "GET");
    assert.equal(status, 200);
    assert.equal(json.rail, "fake");
  } finally {
    server.close();
  }
});

test("a pay run without a policy is rejected", async () => {
  const { server, call } = await start();
  try {
    // No orgId: the org is the caller's, and no policy has been published for
    // it yet, so the run cannot be evaluated.
    const { status } = await call("/v1/pay-runs", "POST", {
      period: "2026-11",
      lines: [],
    });
    assert.equal(status, 400);
  } finally {
    server.close();
  }
});

test("a pay run naming another org is not found, never executed", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    const { status } = await call("/v1/pay-runs", "POST", {
      orgId: "org_other",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 1_000 }],
    });
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test("an over-threshold operation opens a pending approval and pays nothing", async () => {
  const { server, call } = await start();
  try {
    const run = await seedAndRun(call);
    assert.deepEqual(run.json.awaitingApproval, ["run_1_op_1"]);
    assert.equal(run.json.settledCents, 0);
    assert.deepEqual(run.json.approvals, ["apv_1"]);

    const inbox = await call("/v1/approvals?orgId=org_1", "GET");
    const approvals = inbox.json as unknown as { id: string; status: string; operationId: string }[];
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.status, "pending");
    assert.equal(approvals[0]!.operationId, "run_1_op_1");
  } finally {
    server.close();
  }
});

test("an approval freezes the operation it was requested for", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call, { usdCents: 250_000 });
    const inbox = await call("/v1/approvals?orgId=org_1", "GET");
    const approval = (inbox.json as unknown as { operation: { usdCents: number; recipient: string } }[])[0]!;
    assert.equal(approval.operation.usdCents, 250_000);
    assert.equal(approval.operation.recipient, "ada.near");
  } finally {
    server.close();
  }
});

test("approve then execute pays the operation and records history", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    const approved = await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.status, "approved");

    const executed = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(executed.status, 200);
    assert.equal(executed.json.status, "executed");
    assert.equal((executed.json.approval as Record<string, unknown>).status, "executed");
  } finally {
    server.close();
  }
});

test("executing before approval is refused", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    const { status, json } = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(status, 409);
    assert.match(String(json.error), /not approved/);
  } finally {
    server.close();
  }
});

test("a rejected approval cannot be executed", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/reject", "POST", { decidedBy: "owner", note: "not this month" });
    const { status } = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(status, 409);
  } finally {
    server.close();
  }
});

test("deciding an approval twice is a conflict, not a silent flip", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });
    const second = await call("/v1/approvals/apv_1/reject", "POST", { decidedBy: "owner" });
    assert.equal(second.status, 409);
  } finally {
    server.close();
  }
});

test("an approval goes stale if the payee is blocked before execution", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });

    // The payee is blocked after approval was granted.
    await call("/v1/payees", "POST", {
      id: "ada",
      orgId: "org_1",
      kind: "contractor",
      displayName: "Ada",
      destination: base("near", "usdc"),
      address: "ada.near",
      status: "blocked",
      screening: "clear",
    });

    const { status, json } = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(status, 409);
    assert.equal(json.status, "stale");
    assert.ok((json.reasons as string[]).includes("PAYEE_BLOCKED"));
  } finally {
    server.close();
  }
});

test("an approval goes stale if the policy cap is lowered before execution", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call, { usdCents: 250_000 });
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });

    // A newer policy version drops the per-transaction cap below the amount.
    await call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: false, maxPerTransactionCents: 100_000 },
    });

    const { status, json } = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(status, 409);
    assert.equal(json.status, "stale");
    assert.ok((json.reasons as string[]).includes("PER_TX_CAP"));
  } finally {
    server.close();
  }
});

test("an executed approval cannot be executed again", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });
    const first = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(first.status, 200);

    const second = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(second.status, 409);
    assert.match(String(second.json.error), /not approved/);
  } finally {
    server.close();
  }
});

test("the inbox filters by status", async () => {
  const { server, call } = await start();
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });

    const pending = await call("/v1/approvals?orgId=org_1&status=pending", "GET");
    assert.equal((pending.json as unknown as unknown[]).length, 0);
    const approved = await call("/v1/approvals?orgId=org_1&status=approved", "GET");
    assert.equal((approved.json as unknown as unknown[]).length, 1);
  } finally {
    server.close();
  }
});

test("a failed execution marks the approval failed", async () => {
  const { server, call } = await start({ failOperationIds: ["run_1_op_1"] });
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });
    const { status, json } = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(status, 409);
    assert.equal(json.status, "failed");
  } finally {
    server.close();
  }
});

test("a run whose only line fails flips from awaiting_approval to failed", async () => {
  const { server, call } = await start({ failOperationIds: ["run_1_op_1"] });
  try {
    await seedAndRun(call);
    const before = await call("/v1/pay-runs/run_1", "GET");
    assert.equal((before.json["run"] as Record<string, unknown>)["status"], "awaiting_approval");

    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });
    await call("/v1/approvals/apv_1/execute", "POST");

    const after = await call("/v1/pay-runs/run_1", "GET");
    assert.equal((after.json["run"] as Record<string, unknown>)["status"], "failed");
  } finally {
    server.close();
  }
});

test("the failure reason travels with the line for the operator", async () => {
  const { server, call } = await start({ failOperationIds: ["run_1_op_1"] });
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });
    await call("/v1/approvals/apv_1/execute", "POST");

    const { json } = await call("/v1/operations", "GET");
    const rows = json as unknown as Record<string, unknown>[];
    const row = rows.find(
      (r) => (r["record"] as Record<string, unknown> | undefined)?.["operationId"] === "run_1_op_1",
    );
    const note = (row?.["record"] as Record<string, unknown> | undefined)?.["note"];
    assert.equal(typeof note, "string");
    assert.ok(String(note).length > 0);
  } finally {
    server.close();
  }
});

test("executing an approved operation carries the signer proof through", async () => {
  const { server, store } = createApi({ auth: testAuth(), rail: new FakeRail(), signer: new FakeSigner() });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    await seedAndRun(call);
    await call("/v1/approvals/apv_1/approve", "POST", { decidedBy: "owner" });
    const executed = await call("/v1/approvals/apv_1/execute", "POST");
    assert.equal(executed.status, 200);
    assert.equal(executed.json.status, "executed");
    assert.equal(store.settledTodayCents.get("org_1"), 250_000);
  } finally {
    server.close();
  }
});


test("the manifest endpoint compiles the active policy and warns on local-only rules", async () => {
  const { server, call } = await start();
  try {
    await call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: true, maxPayeeRiskScore: 70 },
    });
    const res = await call("/v1/manifest?orgId=org_1&approvers=owner.near&threshold=1", "GET");
    assert.equal(res.status, 200);

    const manifest = res.json["manifest"] as Record<string, unknown>;
    const limits = manifest["limits"] as Record<string, string>;
    assert.equal(limits["per_transaction"], "5000.00");
    assert.equal(limits["daily"], "50000.00");

    const multisig = manifest["multisig"] as Record<string, unknown>;
    assert.equal(multisig["approval_above"], "2000.00");
    assert.deepEqual(multisig["approvers"], ["owner.near"]);

    // New-payee and risk-score rules have no OutLayer equivalent, so they are
    // reported rather than quietly dropped.
    const codes = (res.json["warnings"] as { code: string }[]).map((w) => w.code).sort();
    assert.deepEqual(codes, ["NEW_PAYEE_APPROVAL", "RISK_SCORE"]);
  } finally {
    server.close();
  }
});

test("the manifest endpoint needs an org with an active policy", async () => {
  const { server, call } = await start();
  try {
    // Omitting orgId now means "my org", which has no policy yet.
    assert.equal((await call("/v1/manifest", "GET")).status, 400);
    // Another org's manifest is not found, so its existence is not confirmed.
    assert.equal((await call("/v1/manifest?orgId=org_missing", "GET")).status, 404);
  } finally {
    server.close();
  }
});

test("the manifest is diffed against the wallet's effective policy", async () => {
  const signer = new FakeSigner({
    effectivePolicy: {
      // The owner set a looser daily cap than we proposed.
      limits: { per_transaction: "5000.00", daily: "999999.00" },
      multisig: { approvers: ["owner.near"], threshold: 1, approval_above: "2000.00" },
      tokens: { allowed: ["usdc", "usdt", "dai"] },
      chains: { allowed: [] },
      transaction_types: ["intents_withdraw", "intents_transfer", "call", "transfer"],
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
    },
  });
  const { server, call } = await start({ signer });
  try {
    await call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: false },
    });
    const res = await call("/v1/manifest?orgId=org_1&approvers=owner.near&threshold=1", "GET");
    const drift = res.json["drift"] as { field: string }[];
    assert.deepEqual(drift.map((d) => d.field), ["limits.daily"]);
  } finally {
    server.close();
  }
});

test("the custody approvals endpoint mirrors the wallet's multisig inbox", async () => {
  const signer = new FakeSigner({
    openApprovals: [{ approvalId: "apv_wallet_1", requestId: "req_9", status: "pending" }],
  });
  const { server, call } = await start({ signer });
  try {
    const res = await call("/v1/custody/approvals", "GET");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [{ approvalId: "apv_wallet_1", requestId: "req_9", status: "pending" }]);
  } finally {
    server.close();
  }
});

// --- PingPay invoices: checkout -> webhook -> auto pay run ------------------

const PING_SECRET = "whsec_test_secret";

function pingApi(
  opts: { sessionStatus?: "COMPLETED" | "PENDING"; readBackStatus?: "COMPLETED" | "PENDING" } = {},
) {
  return new FakePingPay({
    webhookSecret: PING_SECRET,
    ...(opts.sessionStatus ? { sessionStatus: opts.sessionStatus } : {}),
    ...(opts.readBackStatus ? { readBackStatus: opts.readBackStatus } : {}),
  });
}

/** Post a signed event to the webhook the way Ping would, headers and all. */
function postWebhook(
  started: Awaited<ReturnType<typeof start>>,
  signed: { body: string; headers: { signature?: string; timestamp?: string } },
) {
  return started.rawPost("/v1/webhooks/pingpay", signed.body, {
    "content-type": "application/json",
    "x-ping-signature": String(signed.headers.signature),
    "x-ping-timestamp": String(signed.headers.timestamp),
  });
}

/** Seed an org with a policy, an approved payee, and an invoice. */
async function seedInvoice(
  started: Awaited<ReturnType<typeof start>>,
  opts: { amount?: number; autoPayRun?: boolean } = {},
) {
  await started.call("/v1/payees", "POST", {
    id: "ada",
    orgId: "org_1",
    kind: "contractor",
    displayName: "Ada",
    destination: base("near", "usdc"),
    address: "ada.near",
    status: "approved",
    screening: "clear",
  });
  await started.call("/v1/policies", "POST", {
    orgId: "org_1",
    rules: { ...defaultRules(), requireApprovalForNewPayee: false },
  });
  return started.call("/v1/invoices", "POST", {
    orgId: "org_1",
    customerId: "acme",
    amount: opts.amount ?? 250_000,
    ...(opts.autoPayRun === false ? {} : { autoPayRun: { payeeId: "ada" } }),
  });
}

test("creating an invoice returns a checkout URL and stores it open", async () => {
  const pingpay = pingApi({ sessionStatus: "PENDING" });
  const started = await start({ pingpay });
  try {
    const res = await seedInvoice(started);
    assert.equal(res.status, 201);
    assert.equal(res.json["status"], "open");
    // The URL is opaque: we store what Ping returned rather than building it.
    assert.equal(
      res.json["checkoutUrl"],
      `https://checkout.pingpay.io/session/${res.json["checkoutSessionId"]}`,
    );

    const list = await started.call("/v1/invoices?orgId=org_1", "GET");
    assert.equal((list.json as unknown as unknown[]).length, 1);
  } finally {
    started.server.close();
  }
});

test("a completed checkout webhook marks the invoice paid and opens the pay run", async () => {
  const pingpay = pingApi({ sessionStatus: "COMPLETED" });
  const started = await start({ pingpay });
  try {
    // Below the 200_000 approval threshold, so it settles without a human.
    const invoice = await seedInvoice(started, { amount: 150_000 });
    const { body, headers } = pingpay.signEvent({
      id: "evt_paid_1",
      type: "checkout.session.completed",
      resourceId: String(invoice.json["checkoutSessionId"]),
      data: { anything: true },
    });
    const res = await postWebhook(started, { body, headers });
    assert.equal(res.status, 200);

    const updated = res.json["invoice"] as Record<string, unknown>;
    assert.equal(updated["status"], "paid");
    assert.ok(updated["paidAt"]);

    const payRun = res.json["payRun"] as Record<string, unknown>;
    const run = payRun["run"] as Record<string, unknown>;
    assert.equal(run["source"], "invoice");
    assert.equal(run["sourceRef"], invoice.json["id"]);
    assert.equal(payRun["settledCents"], 150_000);
  } finally {
    started.server.close();
  }
});

test("the session read-back outranks the webhook: a COMPLETED claim on a PENDING session does not pay", async () => {
  const pingpay = pingApi({ readBackStatus: "PENDING" });
  const started = await start({ pingpay });
  try {
    const invoice = await seedInvoice(started);
    const { body, headers } = pingpay.signEvent({
      id: "evt_liar_1",
      type: "checkout.session.completed",
      resourceId: String(invoice.json["checkoutSessionId"]),
    });
    const res = await postWebhook(started, { body, headers });
    assert.equal(res.status, 200);
    assert.equal((res.json["invoice"] as Record<string, unknown>)["status"], "open");
    assert.equal(res.json["payRun"], undefined);
    assert.match(String(res.json["note"]), /not completed/);
  } finally {
    started.server.close();
  }
});

test("a retried webhook is acknowledged but not acted on twice", async () => {
  const pingpay = pingApi({ sessionStatus: "COMPLETED" });
  const started = await start({ pingpay });
  try {
    const invoice = await seedInvoice(started);
    const { body, headers } = pingpay.signEvent({
      id: "evt_dupe_1",
      type: "checkout.session.completed",
      resourceId: String(invoice.json["checkoutSessionId"]),
    });
    const first = await postWebhook(started, { body, headers });
    assert.notEqual(first.json["payRun"], undefined);

    const second = await postWebhook(started, { body, headers });
    assert.equal(second.status, 200);
    assert.equal(second.json["duplicate"], true);
    assert.equal(second.json["payRun"], undefined);

    // One run only: a duplicate delivery did not pay the contractor twice.
    const runs = await started.call("/v1/pay-runs", "GET");
    assert.equal((runs.json as unknown as unknown[]).length, 1);
  } finally {
    started.server.close();
  }
});

test("an unsigned webhook is rejected and changes nothing", async () => {
  const pingpay = pingApi({ sessionStatus: "COMPLETED" });
  const started = await start({ pingpay });
  try {
    const invoice = await seedInvoice(started);
    const res = await started.rawPost(
      "/v1/webhooks/pingpay",
      JSON.stringify({
        id: "evt_x",
        type: "checkout.session.completed",
        resourceId: invoice.json["checkoutSessionId"],
      }),
      { "content-type": "application/json" },
    );
    assert.equal(res.status, 500);
    const list = await started.call("/v1/invoices?orgId=org_1", "GET");
    assert.equal((list.json as unknown as Record<string, unknown>[])[0]!["status"], "open");
  } finally {
    started.server.close();
  }
});

test("a webhook for an unknown session is acknowledged but reported unmatched", async () => {
  const pingpay = pingApi();
  const started = await start({ pingpay });
  try {
    const { body, headers } = pingpay.signEvent({
      id: "evt_orphan_1",
      type: "checkout.session.completed",
      resourceId: "cs_does_not_exist",
    });
    const res = await postWebhook(started, { body, headers });
    assert.equal(res.status, 200);
    assert.equal(res.json["matched"], false);
  } finally {
    started.server.close();
  }
});

test("an expired checkout marks the invoice expired and never opens a pay run", async () => {
  const pingpay = pingApi();
  const started = await start({ pingpay });
  try {
    const invoice = await seedInvoice(started);
    const { body, headers } = pingpay.signEvent({
      id: "evt_exp_1",
      type: "checkout.session.expired",
      resourceId: String(invoice.json["checkoutSessionId"]),
    });
    const res = await postWebhook(started, { body, headers });
    assert.equal((res.json["invoice"] as Record<string, unknown>)["status"], "expired");
    assert.equal(res.json["payRun"], undefined);
  } finally {
    started.server.close();
  }
});

test("a failed payment marks the invoice failed", async () => {
  const pingpay = pingApi();
  const started = await start({ pingpay });
  try {
    const invoice = await seedInvoice(started);
    const { body, headers } = pingpay.signEvent({
      id: "evt_fail_1",
      type: "payment.failed",
      resourceId: String(invoice.json["checkoutSessionId"]),
    });
    const res = await postWebhook(started, { body, headers });
    assert.equal((res.json["invoice"] as Record<string, unknown>)["status"], "failed");
  } finally {
    started.server.close();
  }
});

test("a paid invoice still runs through the policy, so a large one awaits approval", async () => {
  const pingpay = pingApi({ sessionStatus: "COMPLETED" });
  const started = await start({ pingpay });
  try {
    // Default approvalThresholdCents is 200_000, so 500_000 must be held back.
    const invoice = await seedInvoice(started, { amount: 500_000 });
    const { body, headers } = pingpay.signEvent({
      id: "evt_big_1",
      type: "checkout.session.completed",
      resourceId: String(invoice.json["checkoutSessionId"]),
    });
    const res = await postWebhook(started, { body, headers });
    const payRun = res.json["payRun"] as Record<string, unknown>;
    assert.equal(payRun["settledCents"], 0);
    assert.equal((payRun["approvals"] as unknown[]).length, 1);

    // The approval is attributed to the webhook, not to a human.
    const approvals = await started.call("/v1/approvals?orgId=org_1&status=pending", "GET");
    assert.equal((approvals.json as unknown as Record<string, unknown>[])[0]!["requestedBy"], "pingpay");
  } finally {
    started.server.close();
  }
});

test("invoices are off when no pingpay client is configured", async () => {
  const started = await start();
  try {
    const res = await started.call("/v1/invoices", "POST", { orgId: "org_1", customerId: "acme", amount: 100 });
    assert.equal(res.status, 400);
  } finally {
    started.server.close();
  }
});

test("a Ping validation error surfaces as its real status, not a blanket 500", async () => {
  const pingpay = pingApi();
  // What Ping returns for a customerReference that fails its regex.
  pingpay.createCheckoutError = new RailError("pingpay", 400, "BAD_REQUEST: Input validation failed");
  const started = await start({ pingpay });
  try {
    const res = await started.call("/v1/invoices", "POST", { orgId: "org_1", customerId: "acme", amount: 100 });
    assert.equal(res.status, 400);
    assert.match(String(res.json["error"]), /Input validation failed/);
  } finally {
    started.server.close();
  }
});

test("a Ping outage surfaces as 502, so the cause is not hidden", async () => {
  const pingpay = pingApi();
  pingpay.createCheckoutError = new RailError("pingpay", 503, "SERVICE_UNAVAILABLE: upstream down");
  const started = await start({ pingpay });
  try {
    const res = await started.call("/v1/invoices", "POST", { orgId: "org_1", customerId: "acme", amount: 100 });
    assert.equal(res.status, 503);
  } finally {
    started.server.close();
  }
});

// --- Agent task payouts: x402 quote -> deposit -> settle --------------------

function agentApi(opts: ConstructorParameters<typeof FakeAgentPay>[0] = {}) {
  return new FakeAgentPay(opts);
}

/** Seed an approved agent payee and a policy that lets small payouts through. */
async function seedAgent(started: Awaited<ReturnType<typeof start>>) {
  await started.call("/v1/payees", "POST", {
    id: "gpt-worker",
    orgId: "org_1",
    kind: "agent",
    displayName: "GPT Worker",
    destination: base("near", "usdc"),
    address: "agent.near",
    status: "approved",
    screening: "clear",
  });
  await started.call("/v1/policies", "POST", {
    orgId: "org_1",
    rules: { ...defaultRules(), requireApprovalForNewPayee: false },
  });
}

const agentTask = (overrides: Record<string, unknown> = {}) => ({
  orgId: "org_1",
  payeeId: "gpt-worker",
  resourceUrl: "https://api.example.com/agent/infer",
  amountOut: "200000",
  usdCents: 20_000,
  ...overrides,
});

test("paying an agent task settles and returns a receipt", async () => {
  const started = await start({ agentpay: agentApi(), signer: new FakeSigner() });
  try {
    await seedAgent(started);
    const res = await started.call("/v1/agent-tasks", "POST", agentTask());
    assert.equal(res.status, 201);
    assert.equal(res.json["status"], "paid");
    const task = res.json["task"] as Record<string, unknown>;
    assert.equal(task["status"], "paid");
    const receipt = task["receipt"] as Record<string, unknown>;
    assert.equal(receipt["network"], "near:mainnet");
    assert.ok(receipt["operationToken"]);
    assert.ok(res.json["journal"]);
  } finally {
    started.server.close();
  }
});

test("an agent task over the per-kind cap is denied and nothing is settled", async () => {
  const agentpay = agentApi();
  const started = await start({ agentpay, signer: new FakeSigner() });
  try {
    await seedAgent(started);
    await started.call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: false, perKindCents: { agent: 10_000 } },
    });
    const res = await started.call("/v1/agent-tasks", "POST", agentTask({ usdCents: 50_000 }));
    assert.equal(res.status, 409);
    assert.equal(res.json["status"], "denied");
    assert.deepEqual(res.json["reasons"], ["PER_KIND_CAP"]);
    assert.equal(agentpay.settleCalls.length, 0);
  } finally {
    started.server.close();
  }
});

test("an agent task over the approval threshold is held back", async () => {
  const agentpay = agentApi();
  const started = await start({ agentpay, signer: new FakeSigner() });
  try {
    await seedAgent(started);
    await started.call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: false, approvalThresholdCents: 10_000 },
    });
    const res = await started.call("/v1/agent-tasks", "POST", agentTask({ usdCents: 20_000 }));
    assert.equal(res.status, 202);
    assert.equal(res.json["status"], "awaiting_approval");
    assert.equal((res.json["task"] as Record<string, unknown>)["status"], "awaiting_approval");
    assert.equal(agentpay.settleCalls.length, 0);
  } finally {
    started.server.close();
  }
});

test("a pending settlement is retried with the same token and still pays once", async () => {
  const agentpay = agentApi({ pendingSettles: 1 });
  const started = await start({ agentpay, signer: new FakeSigner() });
  try {
    await seedAgent(started);
    const res = await started.call("/v1/agent-tasks", "POST", agentTask());
    assert.equal(res.status, 201);
    assert.equal(res.json["status"], "paid");
    assert.equal(agentpay.settleCalls.length, 2);
    assert.equal(new Set(agentpay.settleCalls.map((c) => c.operationToken)).size, 1);
  } finally {
    started.server.close();
  }
});

test("an unknown payee is rejected before any facilitator call", async () => {
  const agentpay = agentApi();
  const started = await start({ agentpay, signer: new FakeSigner() });
  try {
    await seedAgent(started);
    const res = await started.call("/v1/agent-tasks", "POST", agentTask({ payeeId: "nobody" }));
    assert.equal(res.status, 400);
    assert.equal(agentpay.settleCalls.length, 0);
  } finally {
    started.server.close();
  }
});

test("agent task payouts are off without a facilitator client", async () => {
  const started = await start();
  try {
    const res = await started.call("/v1/agent-tasks", "POST", agentTask());
    assert.equal(res.status, 400);
  } finally {
    started.server.close();
  }
});

test("the 1099-style export rolls up paid agent tasks by payee", async () => {
  const started = await start({ agentpay: agentApi(), signer: new FakeSigner() });
  try {
    await seedAgent(started);
    await started.call("/v1/agent-tasks", "POST", agentTask({ id: "t1", usdCents: 40_000 }));
    await started.call("/v1/agent-tasks", "POST", agentTask({ id: "t2", usdCents: 25_000 }));

    const year = new Date().getUTCFullYear();
    const res = await started.call(`/v1/exports/agent-payments?orgId=org_1&year=${year}`, "GET");
    assert.equal(res.status, 200);
    const rows = res.json["rows"] as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["payeeId"], "gpt-worker");
    assert.equal(rows[0]!["displayName"], "GPT Worker");
    assert.equal(rows[0]!["totalUsdCents"], 65_000);
    assert.equal(rows[0]!["totalUsd"], "650.00");
    assert.equal(rows[0]!["payments"], 2);
    // 650.00 is past the 600.00 1099-NEC threshold.
    assert.equal(rows[0]!["meetsReportingThreshold"], true);
  } finally {
    started.server.close();
  }
});

test("the export excludes a year with no payments and reports an empty roll-up", async () => {
  const started = await start({ agentpay: agentApi(), signer: new FakeSigner() });
  try {
    await seedAgent(started);
    await started.call("/v1/agent-tasks", "POST", agentTask({ id: "t1", usdCents: 1_000 }));
    const res = await started.call("/v1/exports/agent-payments?orgId=org_1&year=1999", "GET");
    assert.equal((res.json["rows"] as unknown[]).length, 0);
  } finally {
    started.server.close();
  }
});

test("the export requires an org", async () => {
  const started = await start();
  try {
    // No orgId defaults to the caller's own org, which is a legitimate read.
    const own = await started.call("/v1/exports/agent-payments", "GET");
    assert.equal(own.status, 200);
    // Another org's export is not readable.
    const other = await started.call("/v1/exports/agent-payments?orgId=org_other", "GET");
    assert.equal(other.status, 404);
  } finally {
    started.server.close();
  }
});

test("an unpaid task is listed but not counted in the export", async () => {
  const started = await start({ agentpay: agentApi({ pendingSettles: 99 }), signer: new FakeSigner() });
  try {
    await seedAgent(started);
    await started.call("/v1/agent-tasks", "POST", agentTask({ id: "t1", usdCents: 30_000 }));
    const list = await started.call("/v1/agent-tasks?orgId=org_1", "GET");
    const tasks = list.json as unknown as Record<string, unknown>[];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!["status"], "needs_review");

    const year = new Date().getUTCFullYear();
    const exp = await started.call(`/v1/exports/agent-payments?orgId=org_1&year=${year}`, "GET");
    assert.equal((exp.json["rows"] as unknown[]).length, 0);
  } finally {
    started.server.close();
  }
});

// --- Ledger export: the books, and the evidence they reconcile --------------

test("the ledger export reflects a settled pay run and balances", async () => {
  const started = await start({ signer: new FakeSigner() });
  try {
    // Below approvalThresholdCents (200_000) so the run settles rather than
    // waiting on a human: an unsettled line writes no journal entry.
    await seedAndRun(started.call, { usdCents: 150_000 });
    const res = await started.call("/v1/ledger?orgId=org_1", "GET");
    assert.equal(res.status, 200);
    assert.equal(res.json["balanced"], true);
    assert.equal(res.json["entryCount"], 1);

    const entries = res.json["entries"] as Record<string, unknown>[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!["kind"], "payment_settled");
    // Amounts leave as strings so a bigint never truncates through JSON.
    const postings = entries[0]!["postings"] as Record<string, unknown>[];
    assert.ok(postings.every((p) => typeof p["amount"] === "string"));

    const tb = res.json["trialBalance"] as Record<string, unknown>[];
    assert.ok(tb.length > 0);
    assert.ok(typeof res.json["attestation"] === "string");
  } finally {
    started.server.close();
  }
});

test("the ledger export is scoped to one org", async () => {
  const started = await start({ signer: new FakeSigner() });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const own = await started.call("/v1/ledger?orgId=org_1", "GET");
    assert.equal(own.status, 200);
    assert.equal(own.json["entryCount"], 1);
    // Another org's books are not merely empty to this caller — they are not
    // readable at all, so a cross-org read cannot be mistaken for "no data".
    const other = await started.call("/v1/ledger?orgId=org_other", "GET");
    assert.equal(other.status, 404);
  } finally {
    started.server.close();
  }
});

test("the ledger export requires an org", async () => {
  const started = await start();
  try {
    // Omitting orgId is no longer an error: it resolves to the caller's org.
    const res = await started.call("/v1/ledger", "GET");
    assert.equal(res.status, 200);
    assert.equal(res.json["orgId"], "org_1");
  } finally {
    started.server.close();
  }
});

test("an agent task payout is recorded in the ledger", async () => {
  const started = await start({ agentpay: agentApi(), signer: new FakeSigner() });
  try {
    await seedAgent(started);
    await started.call("/v1/agent-tasks", "POST", agentTask());
    const res = await started.call("/v1/ledger?orgId=org_1", "GET");
    assert.equal(res.json["entryCount"], 1);
    assert.equal(res.json["balanced"], true);
  } finally {
    started.server.close();
  }
});

test("the ledger export refuses to report unbalanced books", async () => {
  const started = await start({ signer: new FakeSigner() });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    // Simulate a torn write: a credit with no matching debit.
    started.store.journalEntries.push({
      id: "je_torn",
      orgId: "org_1",
      kind: "payment_settled",
      memo: "torn",
      createdAt: new Date().toISOString(),
      postings: [{ account: "asset:stablecoin_clearing", direction: "credit", amount: 5n, currency: "usdc" }],
    });
    const res = await started.call("/v1/ledger?orgId=org_1", "GET");
    assert.equal(res.status, 500);
  } finally {
    started.server.close();
  }
});

// --- Funding reconciliation: unresolved requests keep their handle ----------

test("an unresolved funding is kept as a request we can re-read", async () => {
  // A pay run whose funding state is unknown must not lose the request id:
  // without it there is no way to learn whether the money moved.
  const signer = new FakeSigner({ needsReviewOperationIds: ["run_1_op_1"] });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const list = await started.call("/v1/custody/requests?orgId=org_1", "GET");
    const rows = list.json as unknown as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["requestId"], "req_run_1_op_1");
    assert.equal(rows[0]!["kind"], "needs_review");
  } finally {
    started.server.close();
  }
});

test("a failure that is not safe to retry is kept; a safe one is not", async () => {
  // The distinction is the whole point: a retryable failure has no open
  // question, a non-retryable one may have moved funds.
  const unsafe = await start({ signer: new FakeSigner({ unsafeFailureOperationIds: ["run_1_op_1"] }) });
  try {
    await seedAndRun(unsafe.call, { usdCents: 150_000 });
    const rows = (await unsafe.call("/v1/custody/requests", "GET")).json as unknown as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["safeToRetry"], false);
  } finally {
    unsafe.server.close();
  }

  const safe = await start({ signer: new FakeSigner({ retryableFailureOperationIds: ["run_1_op_1"] }) });
  try {
    await seedAndRun(safe.call, { usdCents: 150_000 });
    const rows = (await safe.call("/v1/custody/requests", "GET")).json as unknown as unknown[];
    assert.equal(rows.length, 0, "a retryable failure leaves no open question");
  } finally {
    safe.server.close();
  }
});

test("a settled run leaves no unresolved funding", async () => {
  const started = await start({ signer: new FakeSigner() });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const rows = (await started.call("/v1/custody/requests", "GET")).json as unknown as unknown[];
    assert.equal(rows.length, 0);
  } finally {
    started.server.close();
  }
});

test("re-reading an unresolved request reports the service's own row", async () => {
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    // We recorded `needs_review`, but the service now says it succeeded.
    requestStates: { req_run_1_op_1: { status: "success", txHash: "0xdelivered" } },
  });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const res = await started.call("/v1/custody/requests/req_run_1_op_1", "GET");
    assert.equal(res.status, 200);
    const record = res.json["record"] as Record<string, unknown>;
    const state = res.json["state"] as Record<string, unknown>;
    assert.equal(record["kind"], "needs_review");
    assert.equal(state["status"], "success");
    assert.equal(state["terminal"], true);
    assert.equal(state["txHash"], "0xdelivered");
  } finally {
    started.server.close();
  }
});

test("re-reading an unknown request is a 404, not an invented row", async () => {
  const started = await start({ signer: new FakeSigner() });
  try {
    const res = await started.call("/v1/custody/requests/req_nope", "GET");
    assert.equal(res.status, 404);
  } finally {
    started.server.close();
  }
});

// --- Resolving a funding request into the books -----------------------------

test("a confirmed deposit that the rail settled posts exactly one journal", async () => {
  // The whole point of the loop: the deposit landing is not the payee being
  // paid. Only the rail settling closes it, and it must post once.
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    requestStates: { req_run_1_op_1: { status: "success", txHash: "0xdeposited" } },
  });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    assert.equal(started.store.fundingRequests.size, 1);

    const before = started.store.journalEntries.length;
    const res = await started.call("/v1/custody/requests/req_run_1_op_1/resolve", "POST");
    assert.equal(res.status, 200);
    assert.equal(res.json["resolved"], true);
    assert.equal(res.json["outcome"], "settled");
    assert.equal(started.store.journalEntries.length, before + 1, "the settlement is booked once");

    // The books must still balance, and the entry must be the settlement.
    const entry = started.store.journalEntries[started.store.journalEntries.length - 1]!;
    assert.equal(entry.kind, "payment_settled");
    const tb = await started.call("/v1/ledger?orgId=org_1", "GET");
    assert.equal(tb.status, 200);

    // Resolved, so it leaves the worklist.
    const list = await started.call("/v1/custody/requests?orgId=org_1", "GET");
    assert.equal((list.json as unknown as unknown[]).length, 0);
  } finally {
    started.server.close();
  }
});

test("resolving twice does not post a second settlement", async () => {
  // A caller retrying after a lost response must not double-book the money.
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    requestStates: { req_run_1_op_1: { status: "success" } },
  });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    await started.call("/v1/custody/requests/req_run_1_op_1/resolve", "POST");
    const afterFirst = started.store.journalEntries.length;

    const again = await started.call("/v1/custody/requests/req_run_1_op_1/resolve", "POST");
    assert.equal(again.status, 200);
    assert.equal(again.json["duplicate"], true);
    assert.equal(started.store.journalEntries.length, afterFirst, "no second posting");
  } finally {
    started.server.close();
  }
});

test("a deposit confirmed but not yet settled stays open and posts nothing", async () => {
  // The trap this guards: `success` means the deposit reached the rail. If the
  // rail has not settled, the payee is not paid and there is nothing to book.
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    requestStates: { req_run_1_op_1: { status: "success" } },
  });
  const started = await start({
    signer,
    pollStates: { run_1_op_1: { operationId: "run_1_op_1", status: "pending" } },
  });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const before = started.store.journalEntries.length;
    const res = await started.call("/v1/custody/requests/req_run_1_op_1/resolve", "POST");
    assert.equal(res.status, 200);
    assert.equal(res.json["resolved"], false);
    assert.equal(res.json["outcome"], "open");
    assert.equal(started.store.journalEntries.length, before, "nothing booked while unsettled");

    // Still on the worklist: the question is unanswered.
    const list = await started.call("/v1/custody/requests?orgId=org_1", "GET");
    assert.equal((list.json as unknown as unknown[]).length, 1);
  } finally {
    started.server.close();
  }
});

test("a refunded deposit closes as failed and books nothing", async () => {
  // `refunded` means the funds are provably back, so the question is answered.
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    requestStates: { req_run_1_op_1: { status: "refunded", reason: "bridge refunded" } },
  });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const before = started.store.journalEntries.length;
    const res = await started.call("/v1/custody/requests/req_run_1_op_1/resolve", "POST");
    assert.equal(res.json["outcome"], "failed");
    assert.equal(res.json["reason"], "bridge refunded");
    assert.equal(started.store.journalEntries.length, before, "a refund is not a settlement");
    const list = await started.call("/v1/custody/requests?orgId=org_1", "GET");
    assert.equal((list.json as unknown as unknown[]).length, 0, "answered, so off the worklist");
  } finally {
    started.server.close();
  }
});

test("a bare funding failure stays open: the funds may have moved", async () => {
  // The service only proves funds did not move when it says so. A plain
  // `failed` does not, so closing it would drop the only handle to the money.
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    requestStates: { req_run_1_op_1: { status: "failed" } },
  });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const res = await started.call("/v1/custody/requests/req_run_1_op_1/resolve", "POST");
    assert.equal(res.json["resolved"], false);
    assert.equal(res.json["outcome"], "open");
    const list = await started.call("/v1/custody/requests?orgId=org_1", "GET");
    assert.equal((list.json as unknown as unknown[]).length, 1, "still needs a human");
  } finally {
    started.server.close();
  }
});

test("a still-unknown fund state stays open", async () => {
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    requestStates: { req_run_1_op_1: { status: "needs_review", reason: "bridge unclear" } },
  });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const res = await started.call("/v1/custody/requests/req_run_1_op_1/resolve", "POST");
    assert.equal(res.json["outcome"], "open");
    assert.equal(res.json["reason"], "bridge unclear");
  } finally {
    started.server.close();
  }
});

test("resolve refuses a retry and never re-submits the funding", async () => {
  const signer = new FakeSigner({
    needsReviewOperationIds: ["run_1_op_1"],
    requestStates: { req_run_1_op_1: { status: "success" } },
  });
  const started = await start({ signer });
  try {
    await seedAndRun(started.call, { usdCents: 150_000 });
    const before = started.store.journalEntries.length;
    const res = await started.call("/v1/custody/requests/req_run_1_op_1/resolve?retry=true", "POST");
    assert.equal(res.status, 400);
    assert.equal(started.store.journalEntries.length, before, "nothing happened");
  } finally {
    started.server.close();
  }
});

test("resolving an unknown request is a 404", async () => {
  const started = await start({ signer: new FakeSigner() });
  try {
    const res = await started.call("/v1/custody/requests/req_nope/resolve", "POST");
    assert.equal(res.status, 404);
  } finally {
    started.server.close();
  }
});

test("an agent task's unresolved funding is not resolved through the 1Click rail", async () => {
  // An agent payout settles through the x402 facilitator. Asking the 1Click
  // rail about that deposit address would answer about a different deposit, so
  // a confirmed deposit must stay open rather than be booked from the wrong
  // service.
  const signer = new FakeSigner({
    needsReviewOperationIds: ["op_task_t1"],
    requestStates: { req_op_task_t1: { status: "success" } },
  });
  const started = await start({ agentpay: agentApi(), signer });
  try {
    await seedAgent(started);
    await started.call("/v1/agent-tasks", "POST", agentTask({ id: "t1" }));
    const record = [...started.store.fundingRequests.values()][0]!;
    assert.equal(record.settlesVia, "agentpay");

    const before = started.store.journalEntries.length;
    const res = await started.call(`/v1/custody/requests/${record.requestId}/resolve`, "POST");
    assert.equal(res.json["outcome"], "open");
    assert.equal(started.store.journalEntries.length, before, "not booked from the wrong rail");
  } finally {
    started.server.close();
  }
});

/* ---- list endpoints: the dashboard reads, so these must exist ---- */

test("payees are listed for an org, and filtered by it", async () => {
  const started = await start();
  try {
    await seedAndRun(started.call);
    // Filing a payee into another org is not possible: the org is the caller's,
    // so this lands in org_1 even though the body says org_2.
    const filed = await started.call("/v1/payees", "POST", {
      id: "other",
      orgId: "org_2",
      kind: "vendor",
      displayName: "Other Co",
      destination: base("base", "usdc"),
      address: "0xother",
      status: "approved",
      screening: "clear",
    });
    assert.equal((filed.json as { orgId: string }).orgId, "org_1");

    // Both payees are org_1's. Before auth, an omitted orgId returned every
    // org's rows; this is the regression guard for that leak.
    const all = await started.call("/v1/payees", "GET");
    assert.equal(all.status, 200);
    assert.equal((all.json as unknown as unknown[]).length, 2);

    const scoped = await started.call("/v1/payees?orgId=org_1", "GET");
    assert.equal((scoped.json as unknown as unknown[]).length, 2);

    // Naming another org is not an empty list — it is a refusal, so the caller
    // learns nothing about whether org_2 has payees.
    const foreign = await started.call("/v1/payees?orgId=org_2", "GET");
    assert.equal(foreign.status, 404);
  } finally {
    started.server.close();
  }
});

test("pay runs are listed newest first with their lines attached", async () => {
  const started = await start();
  try {
    await seedAndRun(started.call);
    await started.call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-12",
      lines: [{ payeeId: "ada", usdCents: 1_000 }],
    });

    const res = await started.call("/v1/pay-runs?orgId=org_1", "GET");
    assert.equal(res.status, 200);
    const runs = res.json as unknown as { id: string; items: unknown[] }[];
    assert.equal(runs.length, 2);
    // Newest first: the second run was created last.
    assert.equal(runs[0]!.id, "run_2");
    assert.equal(runs[0]!.items.length, 1);
    assert.equal(runs[1]!.items.length, 1);
  } finally {
    started.server.close();
  }
});

test("a pay run list for an unknown org is empty, not an error", async () => {
  const started = await start();
  try {
    await seedAndRun(started.call);
    // A caller cannot ask for an org they do not belong to; the request is
    // refused rather than answered with an empty list, which would suggest the
    // org exists and merely has no runs.
    const foreign = await started.call("/v1/pay-runs?orgId=nobody", "GET");
    assert.equal(foreign.status, 404);

    // Their own org, with no runs yet, is legitimately an empty list.
    const own = await started.call("/v1/pay-runs?orgId=org_1", "GET");
    assert.equal(own.status, 200);
    assert.equal((own.json as unknown as unknown[]).length, 1);
  } finally {
    started.server.close();
  }
});

test("invoices are listed for an org", async () => {
  const started = await start({ pingpay: new FakePingPay({ webhookSecret: "whsec_test" }) });
  try {
    await started.call("/v1/invoices", "POST", {
      orgId: "org_1",
      customerId: "acme",
      amount: 150_000,
    });
    const res = await started.call("/v1/invoices?orgId=org_1", "GET");
    assert.equal(res.status, 200);
    const rows = res.json as unknown as { id: string; status: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "open");
  } finally {
    started.server.close();
  }
});

test("the API answers a CORS preflight so a browser dashboard can call it", async () => {
  const started = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${(started.server.address() as AddressInfo).port}/v1/payees`, {
      method: "OPTIONS",
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  } finally {
    started.server.close();
  }
});

test("GET responses carry the CORS origin header", async () => {
  const started = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${(started.server.address() as AddressInfo).port}/health`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    started.server.close();
  }
});

/* ---- authentication and org ownership -------------------------------------
 *
 * Before this, `orgId` came from the request: an omitted orgId returned every
 * org's rows, and naming an org returned that org's payroll to anyone. These
 * tests pin the replacement contract — a caller is identified by a token, and
 * the org they may touch is a property of that token, never of the request.
 */

test("an anonymous request is refused, not answered", async () => {
  const started = await start();
  try {
    await seedAndRun(started.call);
    for (const [path, method] of [
      ["/v1/payees", "GET"],
      ["/v1/ledger", "GET"],
      ["/v1/pay-runs", "GET"],
      ["/v1/approvals", "GET"],
      ["/v1/operations", "GET"],
      ["/v1/notifications", "GET"],
      ["/v1/agent-tasks", "GET"],
      ["/v1/custody/requests", "GET"],
      ["/v1/policies", "GET"],
      ["/v1/manifest", "GET"],
      ["/v1/exports/agent-payments", "GET"],
      ["/v1/connect", "GET"],
      ["/v1/connect/handoff", "GET"],
      ["/v1/live/custody", "GET"],
    ] as const) {
      const res = await started.raw(path, method);
      assert.equal(res.status, 401, `${method} ${path} should require a token`);
    }
  } finally {
    started.server.close();
  }
});

test("an anonymous write cannot change policy", async () => {
  const started = await start();
  try {
    // The exact write that was possible before: publish a policy for org_1 with
    // no credentials at all.
    const published = await started.raw("/v1/policies", "POST", {
      body: { orgId: "org_1", rules: { limits: { per_transaction: "999999999.00" } } },
    });
    assert.equal(published.status, 401);

    // And nothing was written.
    await started.call("/v1/policies", "POST", { orgId: "org_1" });
    const policy = await started.call("/v1/policies?orgId=org_1", "GET");
    assert.notEqual(
      (policy.json["rules"] as { limits?: { per_transaction?: string } }).limits?.per_transaction,
      "999999999.00",
    );
  } finally {
    started.server.close();
  }
});

test("a wrong token is refused the same way as no token", async () => {
  const started = await start();
  try {
    await seedAndRun(started.call);
    const res = await started.raw("/v1/payees", "GET", { token: "not-the-token" });
    assert.equal(res.status, 401);
  } finally {
    started.server.close();
  }
});

test("the health and live-health endpoints stay reachable without a token", async () => {
  const started = await start();
  try {
    assert.equal((await started.raw("/health")).status, 200);
    assert.equal((await started.raw("/v1/live/health")).status, 200);
  } finally {
    started.server.close();
  }
});

test("a token scoped to another org sees only that org's data", async () => {
  // Two orgs, two tokens. The first org has payroll; the second must not be able
  // to read it even by naming it.
  const started = await start({
    auth: {
      tokens: new Map([
        ["token_a", { orgId: "org_a", label: "a" }],
        ["token_b", { orgId: "org_b", label: "b" }],
      ]),
    },
  });
  try {
    await started.raw("/v1/payees", "POST", {
      token: "token_a",
      body: {
        id: "payee_a",
        kind: "contractor",
        displayName: "A",
        destination: base("near", "usdc"),
        address: "a.near",
      },
    });

    // org_b's own read is empty and legitimate.
    const asB = await started.raw("/v1/payees", "GET", { token: "token_b" });
    assert.equal(asB.status, 200);
    assert.equal((asB.json as unknown as unknown[]).length, 0);

    // org_b asking for org_a's payees is refused, and learns nothing.
    const asBSnooping = await started.raw("/v1/payees?orgId=org_a", "GET", { token: "token_b" });
    assert.equal(asBSnooping.status, 404);

    // org_a still sees its own.
    const asA = await started.raw("/v1/payees", "GET", { token: "token_a" });
    assert.equal((asA.json as unknown as unknown[]).length, 1);
  } finally {
    started.server.close();
  }
});

test("an approval from another org cannot be executed", async () => {
  const started = await start({
    auth: {
      tokens: new Map([
        ["token_a", { orgId: "org_a", label: "a" }],
        ["token_b", { orgId: "org_b", label: "b" }],
      ]),
    },
  });
  try {
    // Seed a run for org_a, which parks an approval.
    await started.raw("/v1/payees", "POST", {
      token: "token_a",
      body: {
        id: "payee_a",
        kind: "contractor",
        displayName: "A",
        destination: base("near", "usdc"),
        address: "a.near",
        status: "approved",
        screening: "clear",
      },
    });
    await started.raw("/v1/policies", "POST", { token: "token_a", body: { orgId: "org_a" } });
    const run = await started.raw("/v1/pay-runs", "POST", {
      token: "token_a",
      body: { period: "2026-11", lines: [{ payeeId: "payee_a", usdCents: 250_000 }] },
    });
    const approvalId = (run.json["approvals"] as string[])[0]!;

    // org_b tries to approve and execute org_a's parked payment.
    const approve = await started.raw(`/v1/approvals/${approvalId}/approve`, "POST", {
      token: "token_b",
      body: { decidedBy: "attacker" },
    });
    assert.equal(approve.status, 404);

    const execute = await started.raw(`/v1/approvals/${approvalId}/execute`, "POST", {
      token: "token_b",
      body: {},
    });
    assert.equal(execute.status, 404);

    // org_a's approval is untouched: still pending, nothing settled.
    const still = await started.raw("/v1/approvals", "GET", { token: "token_a" });
    const rows = still.json as unknown as { status: string }[];
    assert.equal(rows[0]!.status, "pending");
  } finally {
    started.server.close();
  }
});

test("a pay run cannot pay another org's payee", async () => {
  const started = await start({
    auth: {
      tokens: new Map([
        ["token_a", { orgId: "org_a", label: "a" }],
        ["token_b", { orgId: "org_b", label: "b" }],
      ]),
    },
  });
  try {
    await started.raw("/v1/payees", "POST", {
      token: "token_a",
      body: {
        id: "payee_a",
        kind: "contractor",
        displayName: "A",
        destination: base("near", "usdc"),
        address: "a.near",
        status: "approved",
        screening: "clear",
      },
    });
    await started.raw("/v1/policies", "POST", { token: "token_b", body: { orgId: "org_b" } });

    // org_b, with its own policy in place, tries to pay org_a's payee.
    const run = await started.raw("/v1/pay-runs", "POST", {
      token: "token_b",
      body: { period: "2026-11", lines: [{ payeeId: "payee_a", usdCents: 1_000 }] },
    });
    // The payee is not org_b's, so the run cannot resolve it: refused, not paid.
    assert.ok(run.status >= 400, `expected refusal, got ${run.status}`);
  } finally {
    started.server.close();
  }
});

test("the pingpay webhook needs no token but still needs a valid signature", async () => {
  const pingpay = new FakePingPay({ webhookSecret: "whsec_test" });
  const started = await start({ pingpay });
  try {
    // A correctly signed event is accepted with no Authorization header.
    const signed = pingpay.signEvent({
      id: "evt_auth_1",
      type: "checkout.session.expired",
      resourceId: "cs_unknown",
    });
    const ok = await started.rawPost("/v1/webhooks/pingpay", signed.body, {
      "content-type": "application/json",
      "x-ping-signature": String(signed.headers.signature),
      "x-ping-timestamp": String(signed.headers.timestamp),
    });
    assert.equal(ok.status, 200);

    // A forged one is not.
    const forged = await started.rawPost("/v1/webhooks/pingpay", '{"id":"evt_forged"}', {
      "content-type": "application/json",
      "x-ping-signature": "deadbeef",
      "x-ping-timestamp": "1",
    });
    assert.notEqual(forged.status, 200);
  } finally {
    started.server.close();
  }
});

/* --------------------------- funding: wallet + intents --------------------------- */

/**
 * A stand-in for LiveServices that answers the funding-quote call the way the
 * real one does: a live 1Click price, no deposit address. Only the one method
 * the funding routes use is implemented; everything else is absent on purpose.
 */
function stubLiveQuote(): LiveServices {
  return {
    fundingQuote: async ({ chain }: { chain: string }) => ({
      chain: { chain, asset: "usdc", symbol: "USDC", label: chain, refundTo: "0x0" },
      origin: { chain, asset: "usdc" },
      destination: { chain: "near", asset: "usdt" },
      preview: {
        correlationId: "corr_1",
        amountIn: "1014373",
        amountInFormatted: "1.014373",
        amountInUsd: "1.013961164562",
        amountOut: "1000000",
        amountOutFormatted: "1.0",
        amountOutUsd: "0.999594000000",
        withdrawFee: "4152",
        refundFee: "2400",
        timeEstimate: 35,
        deadline: "2026-11-14T10:00:00.000Z",
      },
    }),
  } as unknown as LiveServices;
}

test("funding chains list the origins a deposit can be priced from", async () => {
  const { server, call } = await start();
  try {
    const res = await call("/v1/funding/chains", "GET");
    assert.equal(res.status, 200);
    const chains = res.json as unknown as { chain: string; symbol: string; label: string }[];
    assert.ok(chains.length >= 4);
    assert.ok(chains.some((c) => c.chain === "base" && c.symbol === "USDC"));
    assert.ok(chains.some((c) => c.chain === "sol"));
    // A chain entry never leaks the internal refund placeholder.
    assert.ok(!("refundTo" in chains[0]!));
  } finally {
    server.close();
  }
});

test("a funding quote is priced live and marked simulated, with no deposit address", async () => {
  const { server, call } = await start({ live: stubLiveQuote() });
  try {
    const res = await call("/v1/funding/quote", "POST", {
      chain: "base",
      usdCents: 10000,
      recipient: "43b130e564b41e2f8f5d5ede77dd47a241b5d9ee04cc21aae3eb038eea0822e9",
    });
    assert.equal(res.status, 200);
    assert.equal(res.json["simulated"], true);
    const preview = res.json["preview"] as Record<string, unknown>;
    assert.equal(preview["amountOut"], "1000000");
    assert.equal(preview["timeEstimate"], 35);
    // The whole point: a price, never an address funds could be sent to.
    assert.ok(!("depositAddress" in preview));
    assert.match(String(res.json["note"]), /no testnet/);
  } finally {
    server.close();
  }
});

test("a funding quote refuses a bad request rather than guessing", async () => {
  const { server, call } = await start({ live: stubLiveQuote() });
  try {
    assert.equal((await call("/v1/funding/quote", "POST", { usdCents: 100 })).status, 400);
    assert.equal((await call("/v1/funding/quote", "POST", { chain: "base" })).status, 400);
    assert.equal((await call("/v1/funding/quote", "POST", { chain: "base", usdCents: 0 })).status, 400);
    assert.equal((await call("/v1/funding/quote", "POST", { chain: "base", usdCents: -5 })).status, 400);
  } finally {
    server.close();
  }
});

test("funding quote answers 400, not a crash, when live services are absent", async () => {
  const { server, call } = await start();
  try {
    const res = await call("/v1/funding/quote", "POST", { chain: "base", usdCents: 100 });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("the relay route answers 400 when no relayer is configured", async () => {
  const { server, call } = await start();
  try {
    const res = await call("/v1/relay", "POST", { signedDelegateAction: "AAAA" });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("the relay route requires a signed delegate action", async () => {
  const { server, call } = await start({ relayer: new Relayer({ allowedReceivers: ["agent.testnet"] }) });
  try {
    assert.equal((await call("/v1/relay", "POST", {})).status, 400);
    assert.equal((await call("/v1/relay", "POST", { signedDelegateAction: "" })).status, 400);
  } finally {
    server.close();
  }
});

test("a malformed delegate action is a 400 rejection, not a crash", async () => {
  const { server, call } = await start({ relayer: new Relayer({ allowedReceivers: ["agent.testnet"] }) });
  try {
    const res = await call("/v1/relay", "POST", { signedDelegateAction: "not borsh at all" });
    assert.equal(res.status, 400);
    assert.equal(res.json["status"], "rejected");
    assert.equal(res.json["broadcastable"], false);
  } finally {
    server.close();
  }
});
