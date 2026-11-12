/**
 * Live smoke test: run the real rails against the real services and assert
 * that our parsers accept what they actually return. This is the cheapest
 * shape-drift check we have — it needs no credentials, because the paths it
 * uses are the unauthenticated ones:
 *
 *   - 1Click `GET /v0/tokens` and a dry `POST /v0/quote` (a real quote needs a
 *     partner key; a dry quote prices the corridor without one)
 *   - Ping x402 `GET /agentpay/x402/supported` (discovery advertises capability
 *     without an API key; `/offers`, `/verify` and `/settle` all require one)
 *
 * It is deliberately NOT part of `npm test`: the unit suite must stay offline
 * and deterministic. Run this by hand or on a schedule.
 *
 *   npm run smoke:live
 *
 * Exit code is non-zero if any check fails, so CI can gate on it.
 */
import type { Operation } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import { AssetRegistry, OneClickRail, AgentPayClient, KNOWN_TOKENS, PingPayClient } from "@crewpay/rails";
import type { Quote } from "@crewpay/rails";
import { OutLayerSigner } from "@crewpay/signer";

const ONECLICK_URL = process.env["ONECLICK_BASE_URL"] ?? "https://1click.chaindefuser.com";
const PING_URL = process.env["PING_BASE_URL"] ?? "https://pay.pingpay.io";
const OUTLAYER_TESTNET = process.env["OUTLAYER_TESTNET_URL"] ?? "https://testnet-api.outlayer.ai";
/**
 * Optional PingPay key. When present, the authed paths are exercised too. It is
 * read from the environment only — never committed, never logged.
 */
const PING_API_KEY = process.env["PING_API_KEY"];
const TIMEOUT_MS = 30_000;

const BASE_USDC = { chain: "base", asset: "usdc" } as const;
const NEAR_USDC = { chain: "near", asset: "usdc" } as const;

let failures = 0;
let checks = 0;
let warnings = 0;

function pass(name: string, detail: string): void {
  checks += 1;
  console.log(`  ok   ${name} — ${detail}`);
}

function fail(name: string, detail: string): void {
  checks += 1;
  failures += 1;
  console.error(`  FAIL ${name} — ${detail}`);
}

/** Neither pass nor fail: an external state we cannot fix from code. */
function warn(name: string, detail: string): void {
  warnings += 1;
  console.warn(`  warn ${name} — ${detail}`);
}

/** A fetch that refuses to hang: a dead service must fail the run, not stall it. */
function timeoutFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })) as typeof fetch;
}

/** A realistic payout: base USDC -> near USDC, the corridor the demo uses. */
function sampleOperation(): Operation {
  return {
    id: "smoke_op_1",
    orgId: "smoke_org",
    type: "payout",
    amount: { amount: 1_000_000n, asset: "usdc" },
    usdCents: 100,
    origin: BASE_USDC,
    destination: NEAR_USDC,
    corridor: corridor(BASE_USDC, NEAR_USDC),
    recipient: "997fe4d9e3e1e0e2e0e5e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    refundTo: "0x4200000000000000000000000000000000000006",
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/** A deposit quote as the rail would hand it to the signer, for plan() checks. */
function sampleQuote(): Quote {
  return {
    quoteId: "smoke_quote_1",
    amountOut: 1_000_000n,
    minAmountOut: 990_000n,
    amountIn: 1_014_664n,
    minAmountIn: 1_000_000n,
    feeIn: 0n,
    depositAddress: "997fe4d9e3e1e0e2e0e5e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

async function check1Click(): Promise<void> {
  console.log("\n1Click Swap API (unauthenticated)");
  const f = timeoutFetch();

  // 1. The live token list must still contain every asset we pin offline.
  try {
    const live = await AssetRegistry.fromApi(f, ONECLICK_URL);
    const missing = KNOWN_TOKENS.filter((t) => !live.get(t.blockchain, t.symbol));
    const moved = KNOWN_TOKENS.filter((t) => {
      const found = live.get(t.blockchain, t.symbol);
      return found && found.assetId !== t.assetId;
    });
    if (missing.length || moved.length) {
      fail(
        "GET /v0/tokens",
        `${missing.length} pinned assets missing, ${moved.length} moved ` +
          `(${[...missing, ...moved].map((t) => `${t.blockchain}:${t.symbol}`).join(", ")})`,
      );
    } else {
      pass("GET /v0/tokens", `${KNOWN_TOKENS.length} pinned assets present, ids unchanged`);
    }
  } catch (e) {
    fail("GET /v0/tokens", `registry build threw: ${(e as Error).message}`);
  }

  // 2. A dry quote must parse through the real rail and return sane numbers.
  //    `dry: true` is what makes this work without a partner key.
  try {
    const rail = new OneClickRail({
      baseUrl: ONECLICK_URL,
      registry: AssetRegistry.known(),
      refundTo: "0x4200000000000000000000000000000000000006",
      dry: true,
      fetchImpl: f,
    });
    const q = await rail.quote(sampleOperation());
    const sane = q.amountOut > 0n && q.amountIn > 0n && q.quoteId.length > 0;
    if (!sane) {
      fail("POST /v0/quote (dry)", `quote parsed but not sane: ${JSON.stringify({
        quoteId: q.quoteId, amountIn: String(q.amountIn), amountOut: String(q.amountOut),
      })}`);
    } else {
      pass(
        "POST /v0/quote (dry)",
        `parsed: quoteId=${q.quoteId.slice(0, 8)}… in=${q.amountIn} out=${q.amountOut}`,
      );
    }
    if (q.depositAddress) {
      console.log("       note: dry quote returned a depositAddress; dry semantics may have changed");
    }
  } catch (e) {
    fail("POST /v0/quote (dry)", `quote threw: ${(e as Error).message}`);
  }
}

async function checkPingX402(): Promise<void> {
  console.log("\nPing Agent Pay facilitator (x402 discovery, unauthenticated)");
  const f = timeoutFetch();

  try {
    const client = new AgentPayClient({
      baseUrl: PING_URL,
      apiKey: "smoke-no-key-needed-for-discovery",
      refundTo: "0x4200000000000000000000000000000000000006",
      fetchImpl: f,
    });
    const sup = await client.supported();
    const kinds = Array.isArray(sup["kinds"]) ? (sup["kinds"] as Record<string, unknown>[]) : [];
    if (kinds.length === 0) {
      fail("GET /agentpay/x402/supported", "no `kinds[]` in discovery response");
      return;
    }
    const first = kinds[0]!;
    const version = Number(first["x402Version"]);
    const scheme = String(first["scheme"]);
    const extra = (first["extra"] ?? {}) as Record<string, unknown>;
    const backend = String(extra["settlementBackend"] ?? "");
    const transfer = String(extra["assetTransferMethod"] ?? "");
    const flow = String(extra["paymentFlow"] ?? "");

    // These are the assumptions AgentPayClient encodes; if any drifts, the
    // payer flow is wrong and this is where we find out.
    const problems: string[] = [];
    if (version !== 2) problems.push(`x402Version ${version} != 2`);
    if (scheme !== "exact") problems.push(`scheme "${scheme}" != "exact"`);
    if (backend !== "near-intents") problems.push(`settlementBackend "${backend}" != "near-intents"`);
    if (transfer !== "near-intents") problems.push(`assetTransferMethod "${transfer}" != "near-intents"`);
    if (flow !== "upfront") problems.push(`paymentFlow "${flow}" != "upfront"`);

    if (problems.length) {
      fail("GET /agentpay/x402/supported", `assumption drift: ${problems.join("; ")}`);
    } else {
      const nets = kinds.length;
      pass(
        "GET /agentpay/x402/supported",
        `${nets} kinds; x402Version=2 scheme=exact assetTransferMethod=near-intents paymentFlow=upfront`,
      );
    }

    // `/offers` is auth-gated: a 401 here is the expected, correct answer and
    // confirms we are sending the request to the right place with the wrong key.
    try {
      await client.offers({ amountOut: 200_000n, description: "crewpay-smoke" });
      console.log("       note: /offers accepted a placeholder key; a real key may be unnecessary");
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid")) {
        pass("POST /agentpay/x402/offers", "401 as expected without a Ping API key (auth gate live)");
      } else {
        fail("POST /agentpay/x402/offers", `unexpected error: ${msg}`);
      }
    }
  } catch (e) {
    fail("GET /agentpay/x402/supported", `discovery threw: ${(e as Error).message}`);
  }
}

/**
 * OutLayer testnet is the only real testnet any of the four adapters has. It
 * needs a `wk_` key minted on testnet, and `POST /register` with an empty body
 * mints one — so this check is self-contained and needs no external credential.
 *
 * It creates a throwaway wallet, so it is rate-limited (30/min/IP) and should
 * not run in a tight loop. It writes nothing: reads only, plus registration.
 */
async function checkOutLayerTestnet(): Promise<void> {
  console.log(`\nOutLayer custody (testnet ${OUTLAYER_TESTNET})`);
  const f = timeoutFetch();

  let apiKey: string;
  try {
    const res = await f(`${OUTLAYER_TESTNET}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok || typeof body["api_key"] !== "string") {
      fail("POST /register", `expected api_key, got HTTP ${res.status}: ${JSON.stringify(body).slice(0, 160)}`);
      return;
    }
    apiKey = body["api_key"] as string;
    pass("POST /register", `throwaway testnet wallet minted (wk_…, ${String(apiKey).slice(0, 7)}…)`);
  } catch (e) {
    fail("POST /register", `registration threw: ${(e as Error).message}`);
    return;
  }

  const signer = new OutLayerSigner({ apiKey, baseUrl: OUTLAYER_TESTNET, fetchImpl: f });

  // 1. The wallet loads and reports an address. This is the auth path the whole
  //    signer depends on: `Bearer wk_…` against the wallet API.
  try {
    const wallet = await signer.loadWallet();
    if (!wallet.nearAccountId) {
      fail("GET /wallet/v1/address", "wallet loaded but nearAccountId is empty");
    } else {
      pass("GET /wallet/v1/address", `wallet ${wallet.nearAccountId.slice(0, 12)}… via Bearer wk_ auth`);
    }
  } catch (e) {
    fail("GET /wallet/v1/address", `loadWallet threw: ${(e as Error).message}`);
  }

  // 2. The TEE-enforced policy must be readable. The signer reads policy and
  //    never writes it, so this is the read we rely on for drift detection.
  try {
    const policy = await signer.custody!.effectivePolicy();
    pass("GET /wallet/v1/policy", `effective policy read (${Object.keys(policy).length} fields)`);
  } catch (e) {
    fail("GET /wallet/v1/policy", `effectivePolicy threw: ${(e as Error).message}`);
  }

  // 3. Funding-plan selection is pure, but it is the decision that routes money
  //    to the right chain, so assert the base-USDC corridor plans an intents
  //    withdraw rather than an on-chain call.
  try {
    const plan = signer.plan(sampleOperation(), sampleQuote());
    if (plan.route !== "intents") {
      fail("plan(base→near USDC)", `expected intents route, got "${plan.route}"`);
    } else {
      pass("plan(base→near USDC)", `route=${plan.route} token=${plan.token} amount=${plan.amount}`);
    }
  } catch (e) {
    fail("plan(base→near USDC)", `plan threw: ${(e as Error).message}`);
  }
}

/**
 * PingPay authed paths. Only runs when a key is present in the environment.
 *
 * The point is to reach an *application* error rather than an auth error: a 401
 * here means our header name or key handling is wrong, while a 400 about org
 * configuration means our request was well-formed and Ping understood it. The
 * distinction is the whole value of this check — fixture tests cannot see it.
 *
 * Nothing is created: the checkout call fails before a session exists, and if
 * org config were complete we would still only be minting an unpaid session.
 */
async function checkPingPayAuthed(): Promise<void> {
  console.log(`\nPingPay authed paths (${PING_URL})`);
  if (!PING_API_KEY) {
    warn("PING_API_KEY", "not set; skipping authed checks (set it to exercise checkout + facilitator)");
    return;
  }
  const f = timeoutFetch();
  const client = new PingPayClient({ publishableKey: PING_API_KEY, baseUrl: `${PING_URL}/api`, fetchImpl: f });

  // 1. The checkout route is the one that carried a wrong header name. A 401
  //    here is a real regression; a 400 about the recipient is external state.
  try {
    const session = await client.createCheckout({
      amount: 100_000,
      asset: NEAR_USDC,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      customerReference: "crewpay_smoke",
    });
    pass("POST /checkout/sessions", `session minted: ${session.sessionId} (${session.status})`);
  } catch (e) {
    const msg = (e as Error).message;
    const status = (e as { statusCode?: number }).statusCode ?? 0;
    if (status === 401) {
      fail("POST /checkout/sessions", `401 — our key handling is wrong: ${msg}`);
    } else if (/recipient/i.test(msg)) {
      warn("POST /checkout/sessions", `shape accepted, but org has no recipient configured: ${msg}`);
    } else {
      fail("POST /checkout/sessions", `unexpected: ${msg}`);
    }
  }

  // 2. The facilitator's offers route is auth-gated and needs payee metadata on
  //    the org. `agent_pay_misconfigured` proves auth passed and the request
  //    shape was understood.
  const agent = new AgentPayClient({ baseUrl: PING_URL, apiKey: PING_API_KEY, refundTo: "crewpay.near", fetchImpl: f });
  try {
    const offers = await agent.offers({ amountOut: 200_000n, description: "crewpay-smoke" });
    pass("POST /agentpay/x402/offers", `${offers.accepts.length} origin assets offered (org configured)`);
  } catch (e) {
    const code = (e as { code?: string }).code;
    const status = (e as { statusCode?: number }).statusCode ?? 0;
    if (status === 401) {
      fail("POST /agentpay/x402/offers", `401 — key rejected: ${(e as Error).message}`);
    } else if (code === "agent_pay_misconfigured") {
      warn("POST /agentpay/x402/offers", "auth OK, org not configured (Settings → choose receive asset + recipient)");
    } else {
      fail("POST /agentpay/x402/offers", `unexpected: ${(e as Error).message}`);
    }
  }
}

console.log(
  `CrewPay live smoke test\n  1Click:  ${ONECLICK_URL}\n  Ping:    ${PING_URL}\n  OutLayer: ${OUTLAYER_TESTNET}`,
);
await check1Click();
await checkPingX402();
await checkOutLayerTestnet();
await checkPingPayAuthed();

console.log(`\n${checks - failures}/${checks} checks passed${warnings ? `, ${warnings} warning(s)` : ""}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ok: live payloads parse through the real rails");
