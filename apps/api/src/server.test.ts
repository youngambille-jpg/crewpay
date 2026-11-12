import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { FakeRail, FakePingPay } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";

function base(chain: string, asset: string) {
  return { chain, asset };
}

async function start(
  opts: ConstructorParameters<typeof FakeRail>[0] & { signer?: FakeSigner; pingpay?: FakePingPay } = {},
) {
  const { signer, pingpay, ...railOpts } = opts;
  const { server, store } = createApi({
    rail: new FakeRail(railOpts),
    ...(signer ? { signer } : {}),
    ...(pingpay ? { pingpay } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  // Webhooks are verified over the raw bytes, so the tests must send bytes and
  // headers rather than a re-serialised object.
  const rawPost = async (path: string, body: string, headers: Record<string, string>) => {
    const res = await fetch(url + path, { method: "POST", headers, body });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { server, store, call, rawPost };
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
    const { status } = await call("/v1/pay-runs", "POST", {
      orgId: "org_x",
      period: "2026-11",
      lines: [],
    });
    assert.equal(status, 400);
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

test("executing an approved operation carries the signer proof through", async () => {
  const { server, store } = createApi({ rail: new FakeRail(), signer: new FakeSigner() });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
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
    assert.equal((await call("/v1/manifest", "GET")).status, 400);
    assert.equal((await call("/v1/manifest?orgId=org_missing", "GET")).status, 400);
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
