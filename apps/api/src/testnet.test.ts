import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FakeRail } from "@crewpay/rails";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";
import { TEST_TOKEN, testAuth } from "./auth.ts";
import { TestnetServices } from "./testnet.ts";

function mockFetch(responses: readonly { status?: number; body: unknown }[]) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const rpcView = (amount: string) => ({ result: { amount } });
const rpcCallValue = (value: string) => ({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
const okRow = (id: string, extra: Record<string, unknown> = {}) => ({
  request_id: id,
  status: "success",
  result: { tx_hash: `tx_${id}`, ...extra },
});
const registerBody = { api_key: "wk_testnet_1", near_account_id: "w1.testnet", wallet_id: "w1" };

async function start(testnet?: TestnetServices) {
  const { server, store } = createApi({
    auth: testAuth(),
    rail: new FakeRail(),
    ...(testnet ? { testnet } : {}),
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
  const raw = async (path: string, method = "GET") => {
    const res = await fetch(url + path, { method, headers: { "content-type": "application/json" } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { server, store, call, raw };
}

test("testnet wallet registers once and reports live status", async () => {
  const { fn, calls } = mockFetch([
    { body: registerBody },
    { body: rpcView("300000000000000000000000") },
    { body: rpcCallValue("10000000") },
  ]);
  const { server, call } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    const first = await call("/v1/testnet/wallet", "POST", {});
    assert.equal(first.status, 201);
    assert.equal(first.json["account"], "w1.testnet");
    assert.equal(first.json["reused"], false);
    assert.ok(!JSON.stringify(first.json).includes("wk_testnet_1"));

    const status = await call("/v1/testnet/wallet", "GET");
    assert.equal(status.json["connected"], true);
    assert.equal(status.json["gasYocto"], "300000000000000000000000");
    assert.equal(status.json["usdtBase"], "10000000");

    const second = await call("/v1/testnet/wallet", "POST", {});
    assert.equal(second.status, 200);
    assert.equal(second.json["reused"], true);
    assert.equal(calls.length, 3);
  } finally {
    server.close();
  }
});

test("prepare runs storage, mint and recipient steps, then reports ready", async () => {
  const { fn } = mockFetch([
    { body: registerBody },
    { body: rpcView("300000000000000000000000") },
    { body: okRow("q-storage") },
    { body: rpcCallValue("0") },
    { body: okRow("q-mint") },
    { body: rpcCallValue("10000000") },
    { body: okRow("q-recipient") },
    { body: rpcCallValue("10000000") },
    // Second prepare: gas recheck + final balance only; steps are skipped.
    { body: rpcView("299000000000000000000000") },
    { body: rpcCallValue("10000000") },
  ]);
  const { server, call } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    await call("/v1/testnet/wallet", "POST", {});
    const res = await call("/v1/testnet/prepare", "POST", { recipient: "r.testnet", minUsdtBase: "1000000" });
    assert.equal(res.status, 200);
    const body = res.json as unknown as { ready: boolean; steps: { step: string; status: string }[] };
    assert.equal(body.ready, true);
    assert.deepEqual(
      body.steps.map((s) => [s.step, s.status]),
      [
        ["gas", "ok"],
        ["storage_self", "ok"],
        ["mint", "ok"],
        ["storage_recipient", "ok"],
      ],
    );

    const again = await call("/v1/testnet/prepare", "POST", { recipient: "r.testnet", minUsdtBase: "1000000" });
    const againBody = again.json as unknown as { ready: boolean; steps: { step: string; status: string }[] };
    assert.equal(againBody.ready, true);
    assert.deepEqual(
      againBody.steps.map((s) => [s.step, s.status]),
      [
        ["gas", "ok"],
        ["storage_self", "skipped"],
        ["mint", "skipped"],
        ["storage_recipient", "skipped"],
      ],
    );
  } finally {
    server.close();
  }
});

test("prepare without gas reports what is missing and spends nothing", async () => {
  const { fn, calls } = mockFetch([{ body: registerBody }, { body: rpcView("0") }]);
  const { server, call } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    await call("/v1/testnet/wallet", "POST", {});
    const res = await call("/v1/testnet/prepare", "POST", { recipient: "r.testnet" });
    const body = res.json as unknown as { ready: boolean; steps: { step: string; status: string; detail?: string }[] };
    assert.equal(body.ready, false);
    assert.equal(body.steps.length, 1);
    assert.equal(body.steps[0]!.status, "failed");
    assert.match(body.steps[0]!.detail ?? "", /w1\.testnet/);
    assert.equal(calls.length, 2);
  } finally {
    server.close();
  }
});

test("mint registers storage and mints mock USDT to the held wallet", async () => {
  const { fn } = mockFetch([
    { body: registerBody },
    { body: rpcView("300000000000000000000000") },
    { body: okRow("q-storage") },
    { body: okRow("q-mint") },
    { body: rpcCallValue("20000000") },
  ]);
  const { server, call } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    await call("/v1/testnet/wallet", "POST", {});
    const res = await call("/v1/testnet/mint", "POST", { amountBase: "20000000" });
    assert.equal(res.status, 200);
    const body = res.json as unknown as {
      ready: boolean;
      balanceBase: string;
      steps: { step: string; status: string }[];
    };
    assert.equal(body.ready, true);
    assert.equal(body.balanceBase, "20000000");
    assert.deepEqual(
      body.steps.map((s) => [s.step, s.status]),
      [
        ["gas", "ok"],
        ["storage_self", "ok"],
        ["mint", "ok"],
      ],
    );
  } finally {
    server.close();
  }
});

test("mint without gas reports what is missing and spends nothing", async () => {
  const { fn, calls } = mockFetch([{ body: registerBody }, { body: rpcView("0") }]);
  const { server, call } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    await call("/v1/testnet/wallet", "POST", {});
    const res = await call("/v1/testnet/mint", "POST", {});
    const body = res.json as unknown as { ready: boolean; steps: { step: string; status: string; detail?: string }[] };
    assert.equal(body.ready, false);
    assert.equal(body.steps.length, 1);
    assert.equal(body.steps[0]!.status, "failed");
    assert.match(body.steps[0]!.detail ?? "", /w1\.testnet/);
    assert.equal(calls.length, 2);
  } finally {
    server.close();
  }
});

test("mint rejects a non-integer or non-positive amount before spending", async () => {
  const { fn, calls } = mockFetch([{ body: registerBody }]);
  const { server, call } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    await call("/v1/testnet/wallet", "POST", {});
    assert.equal((await call("/v1/testnet/mint", "POST", { amountBase: "1.5" })).status, 400);
    assert.equal((await call("/v1/testnet/mint", "POST", { amountBase: "0" })).status, 400);
    // Only the register call went out; a rejected amount never reaches the chain.
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test("a fresh register persists the wallet key so a restart reuses the account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewpay-wallet-"));
  const statePath = join(dir, "testnet-wallet.json");
  const { fn, calls } = mockFetch([{ body: registerBody }]);
  const first = new TestnetServices({ fetchImpl: fn, statePath });
  const created = await first.register();
  assert.equal(created.account, "w1.testnet");
  assert.equal(created.reused, false);

  const saved = JSON.parse(readFileSync(statePath, "utf8")) as { apiKey: string; account: string };
  assert.equal(saved.apiKey, "wk_testnet_1");
  assert.equal(saved.account, "w1.testnet");
  // The key is a credential: it must not be world-readable.
  assert.equal(statSync(statePath).mode & 0o077, 0);

  // A second boot with the same state file reuses the wallet via GET /address
  // and never calls /register again.
  const addrFn = (async () =>
    new Response(JSON.stringify({ address: "w1.testnet" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const second = new TestnetServices({ fetchImpl: addrFn, statePath });
  const reused = await second.register();
  assert.equal(reused.account, "w1.testnet");
  assert.equal(reused.reused, true);
  // The fresh service made no register call at all.
  assert.equal(calls.length, 1);
});

test("a stale saved key falls back to a fresh register rather than refusing to start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewpay-wallet-"));
  const statePath = join(dir, "testnet-wallet.json");
  writeFileSync(statePath, JSON.stringify({ apiKey: "wk_stale", account: "old.testnet" }));
  const { fn, calls } = mockFetch([
    { status: 401, body: { error: "unauthorized", message: "bad key" } },
    { body: registerBody },
  ]);
  const svc = new TestnetServices({ fetchImpl: fn, statePath });
  const created = await svc.register();
  assert.equal(created.account, "w1.testnet");
  assert.equal(created.reused, false);
  assert.equal(calls.length, 2); // address check, then register
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as { apiKey: string };
  assert.equal(saved.apiKey, "wk_testnet_1");
});

test("an environment-supplied wallet key is restored without minting a new wallet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewpay-wallet-"));
  const statePath = join(dir, "testnet-wallet.json");
  const { fn, calls } = mockFetch([{ body: { address: "env.testnet" } }]);
  const svc = new TestnetServices({ fetchImpl: fn, statePath, restoreApiKey: "wk_env_1" });
  const restored = await svc.register();
  assert.equal(restored.account, "env.testnet");
  assert.equal(restored.reused, true);
  // Only the address check went out; /register was never called.
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/wallet\/v1\/address/);
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as { apiKey: string; account: string };
  assert.equal(saved.apiKey, "wk_env_1");
  assert.equal(saved.account, "env.testnet");
});

test("an invalid environment-supplied key falls back to a fresh register", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewpay-wallet-"));
  const statePath = join(dir, "testnet-wallet.json");
  const { fn, calls } = mockFetch([
    { status: 401, body: { error: "unauthorized", message: "bad key" } },
    { body: registerBody },
  ]);
  const svc = new TestnetServices({ fetchImpl: fn, statePath, restoreApiKey: "wk_bogus" });
  const created = await svc.register();
  assert.equal(created.account, "w1.testnet");
  assert.equal(created.reused, false);
  assert.equal(calls.length, 2); // address check, then register
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as { apiKey: string };
  assert.equal(saved.apiKey, "wk_testnet_1");
});

test("a testnet pay run settles mock USDT through the real loop", async () => {
  const { fn } = mockFetch([
    { body: registerBody },
    { body: { request_id: "f1", status: "success", result: { tx_hash: "tx_test_1" } } },
    { body: { result: { status: { SuccessValue: "" } } } },
  ]);
  const { server, call } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    await call("/v1/testnet/wallet", "POST", {});
    await call("/v1/payees", "POST", {
      id: "user",
      orgId: "org_1",
      kind: "contractor",
      displayName: "testnet user",
      destination: { chain: "near", asset: "usdt" },
      address: "user.testnet",
      status: "approved",
      screening: "clear",
    });
    await call("/v1/policies", "POST", {
      orgId: "org_1",
      rules: { ...defaultRules(), requireApprovalForNewPayee: false },
    });

    const run = await call("/v1/testnet/pay-runs", "POST", {
      orgId: "org_1",
      period: "2026-11",
      origin: { chain: "near", asset: "usdt" },
      lines: [{ payeeId: "user", usdCents: 100 }],
    });
    assert.equal(run.status, 201);
    assert.equal(run.json["settledCents"], 100);
    assert.equal((run.json["run"] as { sourceRef?: string }).sourceRef, "testnet");

    const summary = await call("/v1/pay-runs/run_1", "GET");
    const items = (summary.json as unknown as { items: { state: string; receipt?: { txHash: string } }[] }).items;
    assert.equal(items[0]!.state, "settled");
    assert.equal(items[0]!.receipt?.txHash, "tx_test_1");

    const ledger = await call("/v1/ledger?orgId=org_1", "GET");
    const books = ledger.json as unknown as { balanced: boolean; entries: unknown[] };
    assert.equal(books.balanced, true);
    assert.equal(books.entries.length, 1);
  } finally {
    server.close();
  }
});

test("testnet endpoints refuse anonymous callers and missing pieces", async () => {
  const { fn } = mockFetch([]);
  const { server, call, raw } = await start(new TestnetServices({ fetchImpl: fn }));
  try {
    assert.equal((await raw("/v1/testnet/wallet")).status, 401);
    assert.equal((await raw("/v1/testnet/pay-runs", "POST")).status, 401);
    const naked = await call("/v1/testnet/pay-runs", "POST", { orgId: "org_1", period: "2026-11", lines: [] });
    assert.equal(naked.status, 409);
  } finally {
    server.close();
  }

  const bare = await start(undefined);
  try {
    assert.equal((await bare.call("/v1/testnet/wallet", "POST", {})).status, 400);
    assert.equal((await bare.call("/v1/testnet/wallet", "GET")).status, 400);
    assert.equal((await bare.call("/v1/testnet/prepare", "POST", { recipient: "r.testnet" })).status, 400);
  } finally {
    bare.server.close();
  }
});
