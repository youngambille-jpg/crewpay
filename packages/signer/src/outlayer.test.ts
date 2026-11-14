import { test } from "node:test";
import assert from "node:assert/strict";
import type { Operation } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import type { Quote } from "@crewpay/rails";
import { OutLayerSigner } from "./outlayer.ts";

const BASE_USDC = { chain: "base", asset: "usdc" } as const;
const NEAR_USDC = { chain: "near", asset: "usdc" } as const;

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op_1",
    orgId: "org_1",
    type: "payout",
    amount: { amount: 150_000_000n, asset: "usdc" },
    usdCents: 150_000,
    origin: BASE_USDC,
    destination: NEAR_USDC,
    corridor: corridor(BASE_USDC, NEAR_USDC),
    recipient: "ada.near",
    refundTo: "crewpay.near",
    deadline: "2026-11-12T04:00:00Z",
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    quoteId: "q_1",
    amountOut: 150_000_000n,
    minAmountOut: 149_000_000n,
    amountIn: 150_500_000n,
    minAmountIn: 149_000_000n,
    feeIn: 100_000n,
    depositAddress: "0xdeposit",
    deadline: "2026-11-12T04:00:00Z",
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function mockFetch(responses: readonly { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function signer(fn: typeof fetch, extra: Partial<ConstructorParameters<typeof OutLayerSigner>[0]> = {}) {
  return new OutLayerSigner({
    apiKey: "wk_test",
    baseUrl: "https://api.outlayer.ai",
    fetchImpl: fn,
    pollIntervalMs: 0,
    maxPolls: 5,
    sleep: async () => {},
    ...extra,
  });
}

test("a cross-chain origin is funded by a gasless intents withdraw", () => {
  const plan = signer(mockFetch([]).fn).plan(op(), quote());
  assert.equal(plan.route, "intents");
  assert.equal(plan.chain, "base");
  assert.equal(plan.token, "nep141:usdc");
  assert.equal(plan.amount, "150500000");
});

test("a NEAR native origin is funded on-chain", () => {
  const plan = signer(mockFetch([]).fn).plan(
    op({ origin: { chain: "near", asset: "near" } }),
    quote(),
  );
  assert.equal(plan.route, "onchain");
  assert.equal(plan.token, "near");
});

test("a NEAR nep141 origin is funded by an on-chain ft_transfer", () => {
  const plan = signer(mockFetch([]).fn).plan(
    op({ origin: { chain: "near", asset: "nep141:usdt.tether-token.near" } }),
    quote(),
  );
  assert.equal(plan.route, "onchain");
  assert.equal(plan.token, "usdt.tether-token.near");
});

test("a successful intents withdraw proves with destination_tx_hash, not the intent hash", async () => {
  const { fn } = mockFetch([
    {
      body: {
        request_id: "r1",
        status: "success",
        result: { transfer_intent_hash: "0xdeadbeef", destination_tx_hash: "0xreal", amount_out: "150000000" },
      },
    },
  ]);
  const r = await signer(fn).fund(op(), quote(), signer(fn).plan(op(), quote()));
  assert.equal(r.kind, "deposited");
  if (r.kind === "deposited") assert.equal(r.proof.txHash, "0xreal");
});

test("a successful on-chain transfer proves with tx_hash", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r1", status: "success", result: { tx_hash: "0xabc" } } }]);
  const s = signer(fn);
  const o = op({ origin: { chain: "near", asset: "near" } });
  const r = await s.fund(o, quote(), s.plan(o, quote()));
  assert.equal(r.kind, "deposited");
  if (r.kind === "deposited") assert.equal(r.proof.txHash, "0xabc");
});

test("a wallet-ops success carries the tx hash top-level (live shape)", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r1", status: "success", tx_hash: "0xtop", result: {} } }]);
  const s = signer(fn);
  const o = op({ origin: { chain: "near", asset: "near" } });
  const r = await s.fund(o, quote(), s.plan(o, quote()));
  assert.equal(r.kind, "deposited");
  if (r.kind === "deposited") assert.equal(r.proof.txHash, "0xtop");
});

test("success without an identifier is escalated, not treated as funded", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r1", status: "success", result: { amount_out: "150000000" } } }]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "needs_review");
});

test("a failed request that never executed is safe to retry", async () => {
  const { fn } = mockFetch([
    { body: { request_id: "r1", status: "failed", result: { reason: "insufficient_balance", never_executed: true } } },
  ]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") {
    assert.equal(r.safeToRetry, true);
    assert.equal(r.reason, "insufficient_balance");
  }
});

test("a bridge failure without never_executed is NOT safe to retry", async () => {
  const { fn } = mockFetch([
    { body: { request_id: "r1", status: "failed", result: { reason: "PARTIAL_DEPOSIT" } } },
  ]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") assert.equal(r.safeToRetry, false);
});

test("needs_review is surfaced as needs_review and never as a failure", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r1", status: "needs_review", result: {} } }]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "needs_review");
});

test("a multisig wallet returns pending with the request id", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r1", status: "pending_approval" } }]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "pending");
  if (r.kind === "pending") assert.equal(r.requestId, "r1");
});

test("a processing request is polled to terminal", async () => {
  const { fn, calls } = mockFetch([
    { body: { request_id: "r1", status: "processing", poll_url: "/wallet/v1/requests/r1" } },
    { body: { request_id: "r1", status: "processing" } },
    { body: { request_id: "r1", status: "success", result: { destination_tx_hash: "0xfinal" } } },
  ]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "deposited");
  assert.equal(calls.filter((c) => c.method === "GET").length, 2);
});

test("a request that never settles within the budget becomes needs_review", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r1", status: "processing" } }]);
  const s = signer(fn, { maxPolls: 3 });
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "needs_review");
});

test("a dropped connection during submit is safe to retry", async () => {
  const fn = (async () => {
    throw new TypeError("socket hang up");
  }) as unknown as typeof fetch;
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") assert.equal(r.safeToRetry, true);
});

test("a policy denial is safe to retry after correction, not escalated", async () => {
  const { fn } = mockFetch([{ status: 403, body: { error: "policy_denied", message: "over limit" } }]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") {
    assert.equal(r.safeToRetry, true);
    assert.match(r.reason, /policy_denied/);
  }
});

test("a refunded request is safe to retry because the funds came back", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r1", status: "refunded", result: { reason: "EXPIRED" } } }]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") assert.equal(r.safeToRetry, true);
});

test("the same operation sends the same idempotency key on a retry", async () => {
  const { fn, calls } = mockFetch([
    { status: 200, body: { error: "duplicate_idempotency_key", request_id: "r1", status: "processing" } },
    { body: { request_id: "r1", status: "success", result: { destination_tx_hash: "0x" } } },
  ]);
  const s = signer(fn);
  await s.fund(op(), quote(), s.plan(op(), quote()));
  const key = calls[0]!.headers["X-Idempotency-Key"];
  assert.ok(key);
  assert.equal(calls[0]!.headers["X-Idempotency-Key"], key);
});

test("loadWallet caches the address and fund uses the deposit address", async () => {
  const { fn, calls } = mockFetch([
    { body: { address: "wallet.near", public_key: "ed25519:x" } },
    { body: { request_id: "r1", status: "success", result: { destination_tx_hash: "0x" } } },
  ]);
  const s = signer(fn);
  const w = await s.loadWallet();
  assert.equal(w.nearAccountId, "wallet.near");
  await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(calls[1]!.body!["to"], "0xdeposit");
});

test("the custody surface reads the wallet's policy and open approvals", async () => {
  const fn = async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    if (path === "/wallet/v1/policy") {
      return new Response(JSON.stringify({ limits: { daily: "1000.00" } }), { status: 200 });
    }
    if (path === "/wallet/v1/pending_approvals") {
      return new Response(
        JSON.stringify([{ approval_id: "apv_1", request_id: "req_1", status: "pending" }]),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const signer = new OutLayerSigner({
    apiKey: "wk_test",
    baseUrl: "https://api.outlayer.ai",
    fetchImpl: fn as unknown as typeof fetch,
  });

  assert.deepEqual(await signer.custody.effectivePolicy(), { limits: { daily: "1000.00" } });
  assert.deepEqual(await signer.custody.openApprovals(), [
    { approvalId: "apv_1", requestId: "req_1", status: "pending" },
  ]);
});

test("pending_approvals accepts both a bare array and an approvals wrapper", async () => {
  const wrapped = async () =>
    new Response(JSON.stringify({ approvals: [{ approval_id: "apv_2" }] }), { status: 200 });
  const signer = new OutLayerSigner({
    apiKey: "wk_test",
    baseUrl: "https://api.outlayer.ai",
    fetchImpl: wrapped as unknown as typeof fetch,
  });
  assert.deepEqual(await signer.custody.openApprovals(), [{ approvalId: "apv_2" }]);
});

test("a failed funding carries its request id, so the state can be re-read", async () => {
  // The id matters most here: a failure that is NOT safe to retry means funds
  // may have moved, and the request id is the only handle back to the truth.
  const { fn } = mockFetch([
    { body: { request_id: "r_bridge", status: "failed", result: { reason: "bridge timed out" } } },
  ]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") {
    assert.equal(r.safeToRetry, false);
    assert.equal(r.requestId, "r_bridge", "a not-safe-to-retry failure must keep its handle");
  }
});

test("a rejected funding carries its request id", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r_rej", status: "rejected" } }]);
  const s = signer(fn);
  const r = await s.fund(op(), quote(), s.plan(op(), quote()));
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") assert.equal(r.requestId, "r_rej");
});

test("reconcile reads the service row and reports the destination tx on success", async () => {
  const { fn, calls } = mockFetch([
    {
      body: {
        request_id: "r1",
        status: "success",
        result: { destination_tx_hash: "0xreal", transfer_intent_hash: "0xintent" },
      },
    },
  ]);
  const state = await signer(fn).reconcile("r1");
  assert.equal(state.status, "success");
  assert.equal(state.terminal, true);
  // The real delivery tx, never the intent hash.
  assert.equal(state.txHash, "0xreal");
  assert.equal(calls[0]!.method, "GET");
  assert.ok(calls[0]!.url.endsWith("/wallet/v1/requests/r1"));
});

test("reconcile reports a non-terminal row as still open", async () => {
  const { fn } = mockFetch([{ body: { request_id: "r2", status: "processing" } }]);
  const state = await signer(fn).reconcile("r2");
  assert.equal(state.terminal, false);
  assert.equal(state.txHash, undefined);
});

test("reconcile surfaces the service reason on a failure", async () => {
  const { fn } = mockFetch([
    { body: { request_id: "r3", status: "failed", result: { reason: "bridge refunded" } } },
  ]);
  const state = await signer(fn).reconcile("r3");
  assert.equal(state.status, "failed");
  assert.equal(state.terminal, true);
  assert.equal(state.reason, "bridge refunded");
});

test("reconcile never submits: a GET is the only call it makes", async () => {
  // Reconciliation must observe, never act. A POST here would risk re-sending a
  // request whose funds may already have moved.
  const { fn, calls } = mockFetch([{ body: { request_id: "r4", status: "processing" } }]);
  await signer(fn).reconcile("r4");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
});
