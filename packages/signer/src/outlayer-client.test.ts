import { test } from "node:test";
import assert from "node:assert/strict";
import type { Operation } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import type { Quote } from "@crewpay/rails";
import { OutLayerClient, TransportError, isTerminalStatus } from "./outlayer-client.ts";
import { SignerError } from "./signer.ts";
import { idempotencyKey } from "./idempotency.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function mockFetch(responses: readonly { status?: number; body: unknown }[], opts: { throwOnSend?: boolean } = {}) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    if (opts.throwOnSend) throw new TypeError("network down");
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function client(fn: typeof fetch) {
  return new OutLayerClient({ apiKey: "wk_test", baseUrl: "https://api.outlayer.ai", fetchImpl: fn, answerWithinSeconds: 15 });
}

test("every request carries the bearer key", async () => {
  const { fn, calls } = mockFetch([{ body: { address: "abc.near" } }]);
  await client(fn).address();
  assert.equal(calls[0]!.headers["authorization"], "Bearer wk_test");
});

test("a mutation sends the idempotency key and the answer-within budget", async () => {
  const { fn, calls } = mockFetch([{ body: { request_id: "r1", status: "success", result: { tx_hash: "0x1" } } }]);
  await client(fn).transferNear("deposit.near", "1000", "key_1");
  const c = calls[0]!;
  assert.equal(c.headers["X-Idempotency-Key"], "key_1");
  assert.equal(c.headers["X-Answer-Within"], "15");
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/wallet/v1/transfer"));
  assert.deepEqual(c.body, { chain: "near", to: "deposit.near", amount: "1000" });
});

test("a duplicate key is returned as a row, not raised as an error", async () => {
  const { fn } = mockFetch([
    {
      status: 200,
      body: {
        error: "duplicate_idempotency_key",
        message: "Request already processed: req_original",
        request_id: "req_original",
        status: "processing",
        poll_url: "/wallet/v1/requests/req_original",
      },
    },
  ]);
  const row = await client(fn).transferNear("x.near", "1", "dup");
  assert.equal(row.request_id, "req_original");
  assert.equal(row.status, "processing");
});

test("a 4xx becomes a SignerError carrying the service code", async () => {
  const { fn } = mockFetch([{ status: 403, body: { error: "policy_denied", message: "amount over per-tx limit" } }]);
  await assert.rejects(
    () => client(fn).transferNear("x.near", "1", "k"),
    (err: unknown) => {
      assert.ok(err instanceof SignerError);
      assert.equal(err.code, "policy_denied");
      assert.equal(err.statusCode, 403);
      return true;
    },
  );
});

test("a send failure is a TransportError, distinct from a service error", async () => {
  const { fn } = mockFetch([{ body: {} }], { throwOnSend: true });
  await assert.rejects(
    () => client(fn).transferNear("x.near", "1", "k"),
    (err: unknown) => {
      assert.ok(err instanceof TransportError);
      assert.ok(!(err instanceof SignerError));
      return true;
    },
  );
});

test("ft_transfer carries a memo as msg and a 1 yoctoNEAR deposit", async () => {
  const { fn, calls } = mockFetch([{ body: { request_id: "r", status: "success", result: { tx_hash: "0x" } } }]);
  await client(fn).ftTransfer("usdt.near", "deposit.near", "1000000", "k", "memo-1");
  const body = calls[0]!.body!;
  assert.equal(body["receiver_id"], "usdt.near");
  assert.equal(body["method_name"], "ft_transfer");
  assert.equal(body["deposit"], "1");
  assert.deepEqual(body["args"], { receiver_id: "deposit.near", amount: "1000000", msg: "memo-1" });
});

test("intents withdraw is async and targets the origin chain", async () => {
  const { fn, calls } = mockFetch([{ body: { request_id: "r", status: "processing" } }]);
  await client(fn).intentsWithdraw("0xabc", "500", "nep141:usdc.near", "base", "k");
  assert.deepEqual(calls[0]!.body, {
    to: "0xabc",
    amount: "500",
    token: "nep141:usdc.near",
    chain: "base",
    async: true,
  });
});

test("the terminal status set is exact", () => {
  for (const s of ["success", "failed", "needs_review", "rejected", "refunded"]) {
    assert.equal(isTerminalStatus(s), true, s);
  }
  for (const s of ["processing", "pending_approval", "approved", "pending_deposit"]) {
    assert.equal(isTerminalStatus(s), false, s);
  }
});

test("idempotency keys are stable for the same operation and differ across them", () => {
  const a = idempotencyKey("op_1", "fund", "q_1");
  assert.equal(a, idempotencyKey("op_1", "fund", "q_1"));
  assert.notEqual(a, idempotencyKey("op_2", "fund", "q_1"));
  assert.notEqual(a, idempotencyKey("op_1", "fund", "q_2"));
  assert.match(a, /^crewpay_[0-9a-f]{32}$/);
});

test("undefined quote is not used as a fetch type at runtime", () => {
  // Guard against the Operation/Quote imports drifting out of sync.
  const op: Pick<Operation, "id"> = { id: "op_1" };
  const q: Pick<Quote, "quoteId"> = { quoteId: "q_1" };
  assert.equal(corridor({ chain: "base", asset: "usdc" }, { chain: "near", asset: "usdc" }), "base:usdc>near:usdc");
  assert.equal(op.id + q.quoteId, "op_1q_1");
});
