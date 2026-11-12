import { test } from "node:test";
import assert from "node:assert/strict";
import type { Operation } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import { AssetRegistry } from "./assets.ts";
import { OneClickRail, mapStatus } from "./oneclick.ts";
import { RailError } from "./settlement.ts";

const BASE_USDC = { chain: "base", asset: "usdc" } as const;
const NEAR_USDC = { chain: "near", asset: "usdc" } as const;

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op_1",
    orgId: "org_1",
    type: "payout",
    amount: { amount: 150_000n * 10_000n, asset: "usdc" },
    usdCents: 150_000,
    origin: BASE_USDC,
    destination: NEAR_USDC,
    corridor: corridor(BASE_USDC, NEAR_USDC),
    recipient: "ada.near",
    refundTo: "crewpay.near",
    deadline: "2026-11-12T04:00:00.000Z",
    ...overrides,
  };
}

/** Recorded shape from the published OpenAPI spec. */
const QUOTE_RESPONSE = {
  correlationId: "550e8400-e29b-41d4-a716-446655440000",
  timestamp: "2026-11-12T03:00:00Z",
  signature: "sig_abc123",
  quoteRequest: {},
  quote: {
    depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8",
    amountIn: "1501000000",
    amountInFormatted: "150.1",
    amountInUsd: "150.1",
    minAmountIn: "1485000000",
    amountOut: "1500000000",
    amountOutFormatted: "150",
    amountOutUsd: "150",
    minAmountOut: "1485000000",
    deadline: "2026-11-12T04:00:00Z",
    timeEstimate: 120,
    withdrawFee: "100000",
    refundFee: "10000",
  },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
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
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function rail(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OneClickRail>[0]> = {}) {
  return new OneClickRail({
    baseUrl: "https://1click.chaindefuser.com",
    registry: AssetRegistry.known(),
    refundTo: "crewpay.near",
    apiKey: "test-key",
    fetchImpl,
    ...extra,
  });
}

test("quote sends the exact shape the API requires", async () => {
  const { fn, calls } = mockFetch([{ body: QUOTE_RESPONSE }]);
  const quote = await rail(fn).quote(op());
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/v0/quote"));
  assert.equal(call.headers["X-API-Key"], "test-key");
  const body = call.body as Record<string, unknown>;
  // Every field in the spec's required list must be present.
  for (const field of [
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
    "deadline",
  ]) {
    assert.ok(field in body, `missing required field ${field}`);
  }
  assert.equal(body.swapType, "EXACT_OUTPUT");
  assert.equal(body.amount, "1500000000");
  assert.equal(body.dry, false, "a real run must not be dry");
  assert.equal(body.originAsset, "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near");
  assert.equal(
    body.destinationAsset,
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  );
});

test("dry mode is opt-in and off by default, so a real run never mints a fake address", async () => {
  const dry = mockFetch([{ body: QUOTE_RESPONSE }]);
  await rail(dry.fn, { dry: true }).quote(op());
  assert.equal((dry.calls[0]!.body as Record<string, unknown>).dry, true);
});

test("quote parses the response into typed bigints and keeps the signature", async () => {
  const { fn } = mockFetch([{ body: QUOTE_RESPONSE }]);
  const quote = await rail(fn).quote(op());
  assert.equal(quote.quoteId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(quote.amountOut, 1_500_000_000n);
  assert.equal(quote.minAmountOut, 1_485_000_000n);
  assert.equal(quote.amountIn, 1_501_000_000n);
  assert.equal(quote.minAmountIn, 1_485_000_000n);
  assert.equal(quote.feeIn, 100_000n);
  assert.equal(quote.evidence, "sig_abc123");
  assert.equal(quote.depositAddress, "0x76b4c56085ED136a8744D52bE956396624a730E8");
});

test("appFees are attached when a take-rate is configured", async () => {
  const { fn, calls } = mockFetch([{ body: QUOTE_RESPONSE }]);
  await rail(fn, { appFee: { recipient: "crewpay.near", fee: 30 } }).quote(op());
  assert.deepEqual((calls[0]!.body as Record<string, unknown>).appFees, [{ recipient: "crewpay.near", fee: 30 }]);
});

test("a quote without a proof reports submitted, not settled", async () => {
  const { fn, calls } = mockFetch([{ body: QUOTE_RESPONSE }]);
  const r = rail(fn);
  const quote = await r.quote(op());
  const result = await r.submit(op(), quote);
  assert.equal(result.status, "submitted");
  // No deposit/submit call should have been made.
  assert.equal(calls.filter((c) => c.url.includes("/deposit/submit")).length, 0);
});

test("a proof notifies the deposit endpoint with the memo", async () => {
  const quoteWithMemo = {
    ...QUOTE_RESPONSE,
    quote: { ...QUOTE_RESPONSE.quote, depositMemo: "1111111" },
  };
  const { fn, calls } = mockFetch([
    { body: quoteWithMemo },
    { body: { correlationId: "c1", status: "PROCESSING", swapDetails: {} } },
  ]);
  const r = rail(fn);
  const quote = await r.quote(op());
  assert.equal(quote.depositMemo, "1111111");
  const result = await r.submit(op(), quote, { txHash: "0xdeposit", nearSenderAccount: "relay.tg" });
  const call = calls[1]!;
  assert.ok(call.url.endsWith("/v0/deposit/submit"));
  assert.deepEqual(call.body, {
    txHash: "0xdeposit",
    depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8",
    nearSenderAccount: "relay.tg",
    memo: "1111111",
  });
  assert.equal(result.status, "pending");
});

test("poll passes the memo back and maps SUCCESS to settled with evidence", async () => {
  const { fn, calls } = mockFetch([
    { body: QUOTE_RESPONSE },
    {
      body: {
        correlationId: "c1",
        status: "SUCCESS",
        swapDetails: {
          intentHashes: ["intent_1"],
          destinationChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://explorer/0xabc" }],
        },
      },
    },
  ]);
  const r = rail(fn);
  const quote = await r.quote(op());
  const result = await r.poll("op_1", quote);
  assert.equal(result.status, "settled");
  assert.equal(result.txHash, "0xabc");
  assert.match(result.evidence ?? "", /intent_1/);
  assert.ok(calls[1]!.url.includes("depositAddress=0x76b4c56085ED136a8744D52bE956396624a730E8"));
});

test("poll maps REFUNDED and FAILED to terminal failure states", async () => {
  const refunded = mockFetch([
    { body: { correlationId: "c1", status: "REFUNDED", swapDetails: { refundReason: "PARTIAL_DEPOSIT" } } },
  ]);
  const r1 = await rail(refunded.fn).poll("op_1");
  assert.equal(r1.status, "refunded");
  assert.equal(r1.failureReason, "PARTIAL_DEPOSIT");

  const failed = mockFetch([{ body: { correlationId: "c2", status: "FAILED", swapDetails: {} } }]);
  const r2 = await rail(failed.fn).poll("op_1");
  assert.equal(r2.status, "failed");
});

test("mapStatus collapses the in-flight states", () => {
  for (const s of ["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING"]) {
    assert.equal(mapStatus(s), "pending");
  }
  assert.equal(mapStatus("SUCCESS"), "settled");
});

test("a non-2xx quote raises RailError carrying the service message", async () => {
  const { fn } = mockFetch([{ status: 400, body: { message: "invalid originAsset" } }]);
  await assert.rejects(
    () => rail(fn).quote(op()),
    (err: unknown) => {
      assert.ok(err instanceof RailError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /invalid originAsset/);
      return true;
    },
  );
});

test("an unknown destination asset fails before any network call", async () => {
  const { fn, calls } = mockFetch([{ body: QUOTE_RESPONSE }]);
  await assert.rejects(
    () => rail(fn).quote(op({ destination: { chain: "near", asset: "wif" } })),
    /no 1Click asset id known for near:wif/,
  );
  assert.equal(calls.length, 0);
});
