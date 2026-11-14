import { test } from "node:test";
import assert from "node:assert/strict";
import type { Operation } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import type { Quote } from "@crewpay/rails";
import { TestnetSigner } from "./testnet.ts";

const NEAR_USDT = { chain: "near", asset: "usdt" } as const;
const BASE_USDC = { chain: "base", asset: "usdc" } as const;

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

function quote(): Quote {
  return {
    quoteId: "testnet_op_1",
    amountOut: 1_000_000n,
    minAmountOut: 1_000_000n,
    amountIn: 1_000_000n,
    minAmountIn: 1_000_000n,
    feeIn: 0n,
    depositAddress: "user.testnet",
    deadline: "2026-11-12T04:00:00Z",
  };
}

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

test("plan names the mock contract on the onchain route", () => {
  const s = new TestnetSigner({ apiKey: "wk_test", fetchImpl: mockFetch([]).fn });
  const plan = s.plan(op(), quote());
  assert.equal(plan.route, "onchain");
  assert.equal(plan.chain, "near");
  assert.equal(plan.token, "usdt.fakes.testnet");
  assert.equal(plan.amount, "1000000");
});

test("plan rejects origins with no mock", () => {
  const s = new TestnetSigner({ apiKey: "wk_test", fetchImpl: mockFetch([]).fn });
  assert.throws(() => s.plan(op({ origin: BASE_USDC }), quote()), /no testnet mock/);
});

test("fund broadcasts the mock transfer and returns the chain tx", async () => {
  const { fn, calls } = mockFetch([
    { body: { request_id: "req_1", status: "success", tx_hash: "tx_mock_1", result: {} } },
  ]);
  const s = new TestnetSigner({ apiKey: "wk_test", fetchImpl: fn, sleep: async () => {} });
  const funding = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(funding.kind, "deposited");
  if (funding.kind === "deposited") assert.equal(funding.proof.txHash, "tx_mock_1");
  assert.match(calls[0]?.url ?? "", /\/wallet\/v1\/call$/);
  assert.equal(calls[0]?.body?.["receiver_id"], "usdt.fakes.testnet");
  assert.equal(calls[0]?.body?.["method_name"], "ft_transfer");
});

test("a synchronous refusal stays retry-safe", async () => {
  const { fn } = mockFetch([{ status: 503, body: { error: "service_unavailable", message: "no solvers" } }]);
  const s = new TestnetSigner({ apiKey: "wk_test", fetchImpl: fn, sleep: async () => {} });
  const funding = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(funding.kind, "failed");
  if (funding.kind === "failed") assert.equal(funding.safeToRetry, true);
});
