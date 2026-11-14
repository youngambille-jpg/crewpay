import { test } from "node:test";
import assert from "node:assert/strict";
import type { Operation } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import { TestnetRail, UnknownMockError, mockAsset } from "./testnet.ts";

const NEAR_USDT = { chain: "near", asset: "usdt" } as const;

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op_1",
    orgId: "org_1",
    type: "payout",
    amount: { amount: 1_000_000n, asset: "usdt" },
    usdCents: 100,
    origin: NEAR_USDT,
    destination: NEAR_USDT,
    corridor: corridor(NEAR_USDT, NEAR_USDT),
    recipient: "user.testnet",
    refundTo: "crewpay.near",
    deadline: "2026-11-12T04:00:00Z",
    ...overrides,
  };
}

function mockFetch(responses: readonly { status?: number; body?: unknown; throws?: string }[]) {
  const calls: { body?: Record<string, unknown> }[] = [];
  let i = 0;
  const fn = (async (_url: string, init?: RequestInit) => {
    calls.push({ ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (r.throws) throw new Error(r.throws);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function rail(fn?: typeof fetch): TestnetRail {
  return new TestnetRail({
    senderAccount: "wallet.testnet",
    ...(fn ? { fetchImpl: fn } : {}),
    sleep: async () => {},
  });
}

test("mock table resolves canonical assets to testnet contracts", () => {
  assert.equal(mockAsset("near", "usdt").contract, "usdt.fakes.testnet");
  assert.equal(mockAsset("NEAR", "USDC").contract, "usdc.fakes.testnet");
  assert.equal(mockAsset("near", "usdt").decimals, 6);
  assert.throws(() => mockAsset("base", "usdc"), UnknownMockError);
});

test("quote pays 1:1 straight to the recipient", async () => {
  const q = await rail().quote(op());
  assert.equal(q.depositAddress, "user.testnet");
  assert.equal(q.amountIn, 1_000_000n);
  assert.equal(q.amountOut, 1_000_000n);
  assert.equal(q.feeIn, 0n);
});

test("quote rejects unmapped assets", async () => {
  await assert.rejects(
    () => rail().quote(op({ destination: { chain: "base", asset: "usdc" } })),
    UnknownMockError,
  );
});

test("submit without the deposit proof fails, not hangs", async () => {
  const r = rail();
  const q = await r.quote(op());
  const res = await r.submit(op(), q);
  assert.equal(res.status, "failed");
  assert.match(res.failureReason ?? "", /deposit proof/);
});

test("submit records the proof and poll verifies it on-chain", async () => {
  const { fn, calls } = mockFetch([{ body: { result: { status: { SuccessValue: "" } } } }]);
  const r = rail(fn);
  const q = await r.quote(op());
  const submitted = await r.submit(op(), q, { txHash: "tx_mock_1" });
  assert.equal(submitted.status, "submitted");
  const settled = await r.poll("op_1", q);
  assert.equal(settled.status, "settled");
  assert.equal(settled.txHash, "tx_mock_1");
  assert.deepEqual(calls[0]?.body?.["params"], ["tx_mock_1", "wallet.testnet"]);
  assert.equal(calls[0]?.body?.["method"], "EXPERIMENTAL_tx_status");
});

test("an on-chain failure settles as failed with the reason", async () => {
  const { fn } = mockFetch([
    { body: { result: { status: { Failure: { ActionError: { kind: "LackBalanceForState" } } } } } },
  ]);
  const r = rail(fn);
  const q = await r.quote(op());
  await r.submit(op(), q, { txHash: "tx_mock_2" });
  const res = await r.poll("op_1", q);
  assert.equal(res.status, "failed");
  assert.match(res.failureReason ?? "", /LackBalanceForState/);
});

test("an unknown tx stays pending, never failed", async () => {
  const { fn } = mockFetch([{ body: { error: { code: -32000, data: "UNKNOWN_TRANSACTION" } } }]);
  const r = rail(fn);
  const q = await r.quote(op());
  await r.submit(op(), q, { txHash: "tx_mock_3" });
  const res = await r.poll("op_1", q);
  assert.equal(res.status, "pending");
});

test("a read failure stays pending", async () => {
  const { fn } = mockFetch([{ throws: "socket hang up" }]);
  const r = rail(fn);
  const q = await r.quote(op());
  await r.submit(op(), q, { txHash: "tx_mock_4" });
  const res = await r.poll("op_1", q);
  assert.equal(res.status, "pending");
});

test("poll without a submit stays pending", async () => {
  const { fn, calls } = mockFetch([]);
  const res = await rail(fn).poll("op_unknown");
  assert.equal(res.status, "pending");
  assert.equal(calls.length, 0);
});
