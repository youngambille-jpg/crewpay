import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { FakeRail } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";
import { TEST_TOKEN, testAuth } from "./auth.ts";

function base(chain: string, asset: string) {
  return { chain, asset };
}

async function start(opts: ConstructorParameters<typeof FakeRail>[0] & { signer?: FakeSigner } = {}) {
  const { signer, ...railOpts } = opts;
  const { server, store } = createApi({
    auth: testAuth(),
    rail: new FakeRail(railOpts),
    ...(signer ? { signer } : {}),
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
  return { server, store, call };
}

type Call = Awaited<ReturnType<typeof start>>["call"];

async function seedPayee(
  call: Call,
  payee: { id: string; kind: string; chain: string; address: string },
) {
  await call("/v1/payees", "POST", {
    id: payee.id,
    orgId: "org_1",
    kind: payee.kind,
    displayName: payee.id,
    destination: base(payee.chain, "usdc"),
    address: payee.address,
    status: "approved",
    screening: "clear",
  });
}

async function seedPolicy(call: Call, rules: Record<string, unknown> = {}) {
  await call("/v1/policies", "POST", {
    orgId: "org_1",
    rules: { ...defaultRules(), requireApprovalForNewPayee: false, ...rules },
  });
}

test("a pay run persists per-line states and decisions", async () => {
  const { server, call } = await start();
  try {
    await seedPayee(call, { id: "ada", kind: "contractor", chain: "near", address: "ada.near" });
    await seedPayee(call, { id: "shop", kind: "vendor", chain: "base", address: "0xshop" });
    await seedPayee(call, { id: "bot", kind: "agent", chain: "near", address: "bot.near" });
    await seedPolicy(call, { perKindCents: { agent: 50_000 } });
    const run = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [
        { payeeId: "ada", usdCents: 150_000 },
        { payeeId: "shop", usdCents: 250_000 },
        { payeeId: "bot", usdCents: 80_000 },
      ],
    });
    assert.equal(run.status, 201);

    const list = await call("/v1/pay-runs?orgId=org_1", "GET");
    const runs = list.json as unknown as { id: string; items: { payeeId: string; state: string }[] }[];
    const states = Object.fromEntries(runs[0]!.items.map((i) => [i.payeeId, i.state]));
    assert.deepEqual(states, { ada: "settled", shop: "awaiting_approval", bot: "denied" });

    const ops = await call("/v1/operations?orgId=org_1", "GET");
    const rows = ops.json as unknown as {
      operation: { id: string };
      record: { decision: string; policyVersion: number; reasonCodes: string[] };
    }[];
    assert.equal(rows.length, 3);
    const decisions = Object.fromEntries(rows.map((r) => [r.operation.id, r.record.decision]));
    assert.deepEqual(decisions, {
      run_1_op_1: "allow",
      run_1_op_2: "allow_with_approval",
      run_1_op_3: "deny",
    });
    for (const r of rows) assert.equal(r.record.policyVersion, 1);
    const denied = rows.find((r) => r.operation.id === "run_1_op_3")!;
    assert.deepEqual(denied.record.reasonCodes, ["PER_KIND_CAP"]);

    const settled = await call("/v1/operations?orgId=org_1&status=settled", "GET");
    assert.equal((settled.json as unknown as unknown[]).length, 1);
  } finally {
    server.close();
  }
});

test("settled lines carry a receipt linked to the journal", async () => {
  const { server, call } = await start();
  try {
    await seedPayee(call, { id: "ada", kind: "contractor", chain: "near", address: "ada.near" });
    await seedPolicy(call);
    await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 150_000 }],
    });

    const res = await call("/v1/pay-runs/run_1", "GET");
    assert.equal(res.status, 200);
    const body = res.json as unknown as {
      run: { id: string };
      items: {
        state: string;
        record: { status: string; txHash: string };
        receipt: { operationId: string; journalEntryId: string; txHash: string };
      }[];
    };
    assert.equal(body.run.id, "run_1");
    assert.equal(body.items[0]!.state, "settled");
    assert.equal(body.items[0]!.record.txHash, "tx_run_1_op_1");
    assert.equal(body.items[0]!.receipt.txHash, "tx_run_1_op_1");
    assert.equal(body.items[0]!.receipt.journalEntryId, "je_run_1_op_1");

    const ledger = await call("/v1/ledger?orgId=org_1", "GET");
    const entries = (ledger.json as unknown as { entries: { id: string }[] }).entries;
    assert.ok(entries.some((e) => e.id === "je_run_1_op_1"));
  } finally {
    server.close();
  }
});

test("an unknown run id is a 404", async () => {
  const { server, call } = await start();
  try {
    assert.equal((await call("/v1/pay-runs/nope", "GET")).status, 404);
    assert.equal((await call("/v1/pay-runs/run_1/deeper", "GET")).status, 404);
  } finally {
    server.close();
  }
});

test("the daily cap holds across runs, not just within one", async () => {
  const { server, call } = await start();
  try {
    await seedPayee(call, { id: "ada", kind: "contractor", chain: "near", address: "ada.near" });
    await seedPolicy(call, { maxDailyCents: 200_000, approvalThresholdCents: 1_000_000 });
    const first = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 150_000 }],
    });
    assert.equal(first.json["settledCents"], 150_000);

    const second = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 150_000 }],
    });
    assert.equal(second.status, 201);
    assert.deepEqual(second.json["denied"], ["run_2_op_1"]);
    assert.equal(second.json["settledCents"], 0);

    const ops = await call("/v1/operations?orgId=org_1&status=denied", "GET");
    const rows = ops.json as unknown as { operation: { id: string }; record: { reasonCodes: string[] } }[];
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.record.reasonCodes, ["DAILY_CAP"]);
  } finally {
    server.close();
  }
});

test("approve then execute settles the line and records a receipt", async () => {
  const { server, call } = await start();
  try {
    await seedPayee(call, { id: "ada", kind: "contractor", chain: "near", address: "ada.near" });
    await seedPolicy(call);
    const run = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 250_000 }],
    });
    const approvalId = (run.json["approvals"] as string[])[0]!;
    assert.equal((await call(`/v1/approvals/${approvalId}/approve`, "POST", { decidedBy: "owner" })).status, 200);

    const executed = await call(`/v1/approvals/${approvalId}/execute`, "POST", {});
    assert.equal(executed.status, 200);
    assert.equal(executed.json["status"], "executed");

    const res = await call("/v1/pay-runs/run_1", "GET");
    const body = res.json as unknown as {
      items: { state: string; receipt: { txHash: string; journalEntryId: string } }[];
    };
    assert.equal(body.items[0]!.state, "settled");
    assert.equal(body.items[0]!.receipt.txHash, "tx_run_1_op_1");
    assert.equal(body.items[0]!.receipt.journalEntryId, "je_run_1_op_1");

    const notes = await call("/v1/notifications?orgId=org_1", "GET");
    const kinds = (notes.json as unknown as { kind: string }[]).map((n) => n.kind);
    assert.deepEqual(kinds, ["approval_needed", "approval_decided", "payee_paid"]);
  } finally {
    server.close();
  }
});

test("executing after a policy change goes stale and denies the line", async () => {
  const { server, call } = await start();
  try {
    await seedPayee(call, { id: "ada", kind: "contractor", chain: "near", address: "ada.near" });
    await seedPolicy(call);
    const run = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 250_000 }],
    });
    const approvalId = (run.json["approvals"] as string[])[0]!;
    await call(`/v1/approvals/${approvalId}/approve`, "POST", { decidedBy: "owner" });
    await seedPolicy(call, { maxPerTransactionCents: 100_000 });

    const executed = await call(`/v1/approvals/${approvalId}/execute`, "POST", {});
    assert.equal(executed.status, 409);
    assert.equal(executed.json["status"], "stale");

    const res = await call("/v1/pay-runs/run_1", "GET");
    const body = res.json as unknown as { items: { state: string }[] };
    assert.equal(body.items[0]!.state, "denied");

    const ops = await call("/v1/operations?orgId=org_1&status=denied", "GET");
    const rows = ops.json as unknown as { record: { policyVersion: number } }[];
    assert.equal(rows[0]!.record.policyVersion, 2);
  } finally {
    server.close();
  }
});

test("resolving an unknown funding settles the line and writes the receipt", async () => {
  const { server, call } = await start({
    signer: new FakeSigner({ needsReviewOperationIds: ["run_1_op_1"] }),
  });
  try {
    await seedPayee(call, { id: "ada", kind: "contractor", chain: "near", address: "ada.near" });
    await seedPolicy(call);
    const run = await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [{ payeeId: "ada", usdCents: 150_000 }],
    });
    assert.deepEqual(run.json["needsReview"], ["run_1_op_1"]);

    const waiting = (await call("/v1/pay-runs/run_1", "GET")).json as unknown as {
      items: { state: string; receipt?: unknown }[];
    };
    assert.equal(waiting.items[0]!.state, "submitted");
    assert.equal(waiting.items[0]!.receipt, undefined);

    const resolved = await call("/v1/custody/requests/req_run_1_op_1/resolve", "POST", {});
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json["outcome"], "settled");

    const res = await call("/v1/pay-runs/run_1", "GET");
    const body = res.json as unknown as {
      items: { state: string; receipt: { txHash: string; journalEntryId: string } }[];
    };
    assert.equal(body.items[0]!.state, "settled");
    assert.equal(body.items[0]!.receipt.txHash, "tx_run_1_op_1");
    assert.equal(body.items[0]!.receipt.journalEntryId, "je_run_1_op_1");

    const ledger = await call("/v1/ledger?orgId=org_1", "GET");
    const entries = (ledger.json as unknown as { entries: { id: string }[] }).entries;
    assert.ok(entries.some((e) => e.id === "je_run_1_op_1"));

    const worklist = await call("/v1/custody/requests?orgId=org_1", "GET");
    assert.deepEqual(worklist.json, []);

    const notes = await call("/v1/notifications?orgId=org_1", "GET");
    const kinds = (notes.json as unknown as { kind: string }[]).map((n) => n.kind);
    assert.deepEqual(kinds, ["payout_needs_review", "payee_paid"]);
  } finally {
    server.close();
  }
});

test("notifications record every pay-run outcome", async () => {
  const { server, call } = await start();
  try {
    await seedPayee(call, { id: "ada", kind: "contractor", chain: "near", address: "ada.near" });
    await seedPayee(call, { id: "shop", kind: "vendor", chain: "base", address: "0xshop" });
    await seedPayee(call, { id: "bot", kind: "agent", chain: "near", address: "bot.near" });
    await seedPolicy(call, { perKindCents: { agent: 50_000 } });
    await call("/v1/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      lines: [
        { payeeId: "ada", usdCents: 150_000 },
        { payeeId: "shop", usdCents: 250_000 },
        { payeeId: "bot", usdCents: 80_000 },
      ],
    });

    const notes = await call("/v1/notifications?orgId=org_1", "GET");
    const rows = notes.json as unknown as { kind: string; to: string }[];
    assert.deepEqual(
      rows.map((r) => [r.kind, r.to]),
      [
        ["payee_paid", "ada"],
        ["payee_denied", "bot"],
        ["approval_needed", "owner"],
      ],
    );
  } finally {
    server.close();
  }
});
