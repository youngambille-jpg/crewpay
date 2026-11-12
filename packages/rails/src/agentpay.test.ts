import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentPayClient, AgentPayError, interpretSettle, type AgentQuote, type X402Accept } from "./agentpay.ts";
import { FakeAgentPay } from "./agentpay-fake.ts";
import { MppChargeClient } from "./mpp.ts";

const OFFER: X402Accept = {
  network: "eip155:8453",
  asset: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  payTo: "",
  amount: "",
};

const QUOTE: AgentQuote = {
  operationToken: "op_1",
  depositAddress: "0xdep",
  amountIn: 200_000n,
  network: "eip155:8453",
  asset: "usdc",
  refundDeadline: "2026-11-03T21:00:00.000Z",
};

function client(fetchImpl: typeof fetch) {
  return new AgentPayClient({ apiKey: "sk_test", refundTo: "0xRefund", fetchImpl });
}

/** Capture the request the client makes, and reply with a canned response. */
function recorder(reply: { status: number; body: unknown; headers?: Record<string, string> }) {
  const seen: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

test("supported() needs no API key and returns the advertised kinds", async () => {
  const { fetchImpl, seen } = recorder({
    status: 200,
    body: { x402Version: 2, kinds: [{ scheme: "exact", network: "near-intents" }] },
  });
  const info = await client(fetchImpl).supported();
  assert.equal(info["x402Version"], 2);
  assert.equal(seen[0]!.headers["x-api-key"], undefined);
  assert.equal(seen[0]!.url, "https://pay.pingpay.io/agentpay/x402/supported");
});

test("offers() sends the destination amount and reads back unquoted accepts", async () => {
  const { fetchImpl, seen } = recorder({
    status: 200,
    body: {
      x402Version: 2,
      accepts: [{ network: "eip155:8453", asset: "usdc", payTo: "", amount: "", extra: { destination: "near:mainnet" } }],
    },
  });
  const offers = await client(fetchImpl).offers({ amountOut: 200_000n, description: "batch job" });
  assert.equal(offers.accepts.length, 1);
  assert.equal(seen[0]!.headers["x-api-key"], "sk_test");
  assert.equal(seen[0]!.body["amountOut"], "200000");
  assert.equal(seen[0]!.body["description"], "batch job");
});

test("offers() with no origin assets is an error, not an empty success", async () => {
  const { fetchImpl } = recorder({ status: 200, body: { x402Version: 2, accepts: [] } });
  await assert.rejects(() => client(fetchImpl).offers({ amountOut: 1n }), /no origin assets/);
});

test("quote() posts a quote payload with refundTo and reads the deposit fields", async () => {
  const { fetchImpl, seen } = recorder({
    status: 200,
    body: {
      isValid: true,
      extra: {
        depositAddress: "0xdep",
        amountIn: "152341",
        refundDeadline: "2026-11-03T21:00:00.000Z",
        operationToken: "op_9",
      },
    },
  });
  const quote = await client(fetchImpl).quote({ offer: OFFER });
  assert.equal(quote.operationToken, "op_9");
  assert.equal(quote.depositAddress, "0xdep");
  assert.equal(quote.amountIn, 152_341n);
  const payload = seen[0]!.body["paymentPayload"] as Record<string, unknown>;
  const inner = payload["payload"] as Record<string, unknown>;
  assert.equal(inner["type"], "quote");
  assert.equal(inner["refundTo"], "0xRefund");
  assert.equal(seen[0]!.body["x402Version"], 2);
});

test("quote() without a refund address fails locally rather than at Ping", async () => {
  // #3370 has no dashboard fallback, so refusing here is the fail-closed choice.
  const { fetchImpl, seen } = recorder({ status: 200, body: { isValid: true, extra: {} } });
  const noRefund = new AgentPayClient({ apiKey: "sk", refundTo: "", fetchImpl });
  await assert.rejects(
    () => noRefund.quote({ offer: OFFER }),
    (err: unknown) => err instanceof AgentPayError && err.code === "refund_address_required",
  );
  assert.equal(seen.length, 0, "must not call the facilitator without a refund address");
});

test("quote() surfaces a Ping refusal with its code", async () => {
  const { fetchImpl } = recorder({
    status: 400,
    body: { isValid: false, errorReason: "invalid_exact_near_intents_quote_unavailable" },
  });
  await assert.rejects(
    () => client(fetchImpl).quote({ offer: OFFER }),
    /invalid_exact_near_intents_quote_unavailable/,
  );
});

test("quote() rejects a malformed 200 that omits the deposit fields", async () => {
  const { fetchImpl } = recorder({ status: 200, body: { isValid: true, extra: { depositAddress: "0xdep" } } });
  await assert.rejects(() => client(fetchImpl).quote({ offer: OFFER }), /omitted depositAddress or operationToken/);
});

test("settle() sends a deposit payload with the operation token and tx hash", async () => {
  const { fetchImpl, seen } = recorder({
    status: 200,
    body: { success: true, transaction: "NEARtxHash", network: "near:mainnet" },
  });
  const result = await client(fetchImpl).settle({ quote: QUOTE, txHash: "0xorigin" });
  assert.equal(result.status, "settled");
  const payload = seen[0]!.body["paymentPayload"] as Record<string, unknown>;
  const inner = payload["payload"] as Record<string, unknown>;
  assert.equal(inner["type"], "deposit");
  assert.equal(inner["operationToken"], "op_1");
  assert.equal(inner["depositAddress"], "0xdep");
  assert.equal(inner["txHash"], "0xorigin");
});

test("a success with no transaction hash is treated as unknown, not settled", () => {
  const result = interpretSettle(200, { success: true, network: "near:mainnet" }, QUOTE);
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.retryable, false);
});

test("settlement_pending is pending, never failed", () => {
  const result = interpretSettle(200, { success: false, errorReason: "settlement_pending" }, QUOTE);
  assert.equal(result.status, "pending");
});

test("INCOMPLETE_DEPOSIT is its own state, not a failure", () => {
  // It arrives as HTTP 200 with success:false. Reading only `success` would call
  // a top-up-able deposit dead and abandon the funds.
  const result = interpretSettle(200, { success: false, extra: { status: "INCOMPLETE_DEPOSIT" } }, QUOTE);
  assert.equal(result.status, "incomplete");
  assert.equal(result.status === "incomplete" && result.depositAddress, "0xdep");
});

test("503 and 504 are retryable, 402 is not", () => {
  assert.equal(interpretSettle(503, { code: "settlement_unavailable" }, QUOTE).status, "failed");
  const transient = interpretSettle(504, { code: "settlement_timeout" }, QUOTE);
  assert.equal(transient.status === "failed" && transient.retryable, true);
  const terminal = interpretSettle(402, { errorReason: "settlement_failed" }, QUOTE);
  assert.equal(terminal.status === "failed" && terminal.retryable, false);
});

test("the fake is idempotent by operation token", async () => {
  const fake = new FakeAgentPay();
  const offer = (await fake.offers({ amountOut: 200_000n })).accepts[0]!;
  const quote = await fake.quote({ offer, refundTo: "0xr" });
  const first = await fake.settle({ quote, txHash: "0xtx" });
  const second = await fake.settle({ quote, txHash: "0xtx" });
  assert.equal(first.status, "settled");
  assert.equal(second.status, "settled");
  assert.deepEqual(
    first.status === "settled" && second.status === "settled" ? second.receipt : null,
    first.status === "settled" ? first.receipt : undefined,
  );
});

test("the fake can demand more input than the nominal amount", async () => {
  const fake = new FakeAgentPay({ amountIn: 300_000n });
  const offer = (await fake.offers({ amountOut: 200_000n })).accepts[0]!;
  const quote = await fake.quote({ offer, refundTo: "0xr" });
  assert.equal(quote.amountIn, 300_000n);
});

test("the fake reports pending then settles on retry with the same token", async () => {
  const fake = new FakeAgentPay({ pendingSettles: 1 });
  const offer = (await fake.offers({ amountOut: 200_000n })).accepts[0]!;
  const quote = await fake.quote({ offer, refundTo: "0xr" });
  const first = await fake.settle({ quote, txHash: "0xtx" });
  const second = await fake.settle({ quote, txHash: "0xtx" });
  assert.equal(first.status, "pending");
  assert.equal(second.status, "settled");
  // Both attempts carried the same token: no second deposit was opened.
  assert.deepEqual(
    fake.settleCalls.map((c) => c.operationToken),
    ["op_1", "op_1"],
  );
});

test("the fake reports INCOMPLETE_DEPOSIT then accepts a top-up retry", async () => {
  const fake = new FakeAgentPay({ incompleteSettles: 1 });
  const offer = (await fake.offers({ amountOut: 200_000n })).accepts[0]!;
  const quote = await fake.quote({ offer, refundTo: "0xr" });
  assert.equal((await fake.settle({ quote, txHash: "0xtx" })).status, "incomplete");
  assert.equal((await fake.settle({ quote, txHash: "0xtx" })).status, "settled");
});

test("MPP charge: a 402 with no credential is the normal unpaid challenge", async () => {
  const { fetchImpl, seen } = recorder({
    status: 402,
    body: { code: "payment_required", amountOut: "250000" },
  });
  const result = await new MppChargeClient({ apiKey: "sk", fetchImpl }).charge({ amountOut: 250_000n });
  assert.equal(result.status, "unpaid");
  assert.equal(seen[0]!.headers["x-api-key"], "sk");
  assert.equal(seen[0]!.url, "https://pay.pingpay.io/agentpay/mpp/charge");
});

test("MPP charge: 202 is pending with a retry hint, not an error", async () => {
  const { fetchImpl } = recorder({ status: 202, body: { code: "settlement_pending" }, headers: { "retry-after": "5" } });
  const result = await new MppChargeClient({ apiKey: "sk", fetchImpl }).charge(
    { amountOut: 1n },
    "credential",
  );
  assert.equal(result.status, "pending");
  assert.equal(result.status === "pending" && result.retryAfterSeconds, 5);
});

test("MPP charge: 200 with a receipt header is paid", async () => {
  const { fetchImpl } = recorder({
    status: 200,
    body: { status: "paid" },
    headers: { "payment-receipt": "NEARtxHash" },
  });
  const result = await new MppChargeClient({ apiKey: "sk", fetchImpl }).charge({ amountOut: 1n }, "cred");
  assert.equal(result.status, "paid");
  assert.equal(result.status === "paid" && result.receipt, "NEARtxHash");
});

test("MPP charge: 401 is thrown, not reported as a failed charge", async () => {
  const { fetchImpl } = recorder({ status: 401, body: { code: "unauthorized" } });
  await assert.rejects(
    () => new MppChargeClient({ apiKey: "bad", fetchImpl }).charge({ amountOut: 1n }),
    (err: unknown) => err instanceof AgentPayError && err.statusCode === 401,
  );
});
