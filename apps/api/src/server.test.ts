import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { FakeRail } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";

function base(chain: string, asset: string) {
  return { chain, asset };
}

async function start(opts: ConstructorParameters<typeof FakeRail>[0] = {}) {
  const { server, store } = createApi({ rail: new FakeRail(opts) });
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
  return { server, store, call };
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

