/**
 * End-to-end test against testnet, as far as testnet goes.
 *
 * What this drives for real:
 *   - OutLayer testnet: register a throwaway wallet, read its address and
 *     policy, dry-run a withdraw (TEE verdict, no broadcast), and attempt a
 *     real fund() — which testnet must refuse, because Intents has no solvers
 *     there. The assertion is that the refusal is classified safe (nothing
 *     moved), never booked as a deposit.
 *   - 1Click (mainnet API, free paths): token list and a dry quote pricing the
 *     payout corridor. 1Click has no testnet, so pricing is the deepest live
 *     rail step available.
 *   - The full local loop through the real API: seed, pay run, approve,
 *     execute, run summary, ledger, notifications — real policy, real books,
 *     simulated settlement.
 *
 * What it does NOT do: move funds. There is no testnet settlement path in this
 * stack (no testnet solvers, no testnet rail), and mock/testnet USDT cannot
 * enter it either — 1Click's asset list is mainnet contracts only, which step
 * B verifies against the live list. A script that claimed a testnet payout
 * settled would be inventing money movement.
 *
 *   npm run e2e:testnet
 *
 * Exit code is non-zero on failure. The wallet key is never logged.
 */
import type { AddressInfo } from "node:net";
import type { Operation } from "@crewpay/domain";
import { corridor, defaultRules } from "@crewpay/domain";
import { AssetRegistry, FakeRail, OneClickRail } from "@crewpay/rails";
import { FakeSigner, OutLayerSigner } from "@crewpay/signer";
import { createApi } from "../apps/api/src/server.ts";
import { TEST_TOKEN, testAuth } from "../apps/api/src/auth.ts";

const ONECLICK_URL = process.env["ONECLICK_BASE_URL"] ?? "https://1click.chaindefuser.com";
const OUTLAYER_TESTNET = process.env["OUTLAYER_TESTNET_URL"] ?? "https://testnet-api.outlayer.ai";
const TIMEOUT_MS = 30_000;

const BASE_USDC = { chain: "base", asset: "usdc" } as const;
const NEAR_USDC = { chain: "near", asset: "usdc" } as const;
/** A well-formed implicit account, as a deposit address would be. */
const SAMPLE_ADDRESS = "997fe4d9e3e1e0e2e0e5e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

let failures = 0;
let checks = 0;

function pass(name: string, detail: string): void {
  checks += 1;
  console.log(`  ok   ${name} — ${detail}`);
}

function fail(name: string, detail: string): void {
  checks += 1;
  failures += 1;
  console.error(`  FAIL ${name} — ${detail}`);
}

function timeoutFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })) as typeof fetch;
}

/** A $1.00 payout, base USDC -> near USDC. */
function sampleOperation(): Operation {
  return {
    id: "e2e_op_1",
    orgId: "e2e_org",
    type: "payout",
    amount: { amount: 1_000_000n, asset: "usdc" },
    usdCents: 100,
    origin: BASE_USDC,
    destination: NEAR_USDC,
    corridor: corridor(BASE_USDC, NEAR_USDC),
    recipient: SAMPLE_ADDRESS,
    refundTo: "0x4200000000000000000000000000000000000006",
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

console.log(`CrewPay testnet E2E\n  1Click:   ${ONECLICK_URL}\n  OutLayer: ${OUTLAYER_TESTNET} (testnet)`);

// --- A. OutLayer testnet: wallet, policy, dry-run (all live) -----------------
console.log("\nA. OutLayer testnet custody (live)");
const f = timeoutFetch();

let apiKey = "";
try {
  const res = await f(`${OUTLAYER_TESTNET}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof body["api_key"] !== "string") {
    fail("POST /register", `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 160)}`);
  } else {
    apiKey = body["api_key"] as string;
    pass("POST /register", "throwaway testnet wallet minted (key held in memory only)");
  }
} catch (e) {
  fail("POST /register", (e as Error).message);
}
if (!apiKey) {
  console.error("\nCannot continue without a wallet; aborting.");
  process.exit(1);
}

const signer = new OutLayerSigner({
  apiKey,
  baseUrl: OUTLAYER_TESTNET,
  fetchImpl: f,
  maxPolls: 2,
  pollIntervalMs: 500,
});

try {
  const wallet = await signer.loadWallet();
  if (!wallet.nearAccountId) fail("wallet address", "empty nearAccountId");
  else pass("wallet address", wallet.nearAccountId);
} catch (e) {
  fail("wallet address", (e as Error).message);
}

try {
  const policy = await signer.custody!.effectivePolicy();
  pass("effective policy", `${Object.keys(policy).length} fields read from the TEE`);
} catch (e) {
  fail("effective policy", (e as Error).message);
}

// The TEE's verdict on the withdraw, with no signing and no broadcast. On an
// unfunded testnet wallet this must come back negative with a reason — a
// verdict, not an error page.
try {
  const res = await f(`${OUTLAYER_TESTNET}/wallet/v1/intents/withdraw/dry-run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ chain: "near", amount: "1000000", to: SAMPLE_ADDRESS, token: "nep141:usdc" }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.ok && body["would_succeed"] === true) {
    fail("dry-run withdraw", "testnet TEE claims an unfunded withdraw would succeed");
  } else {
    const reason = String(body["reason"] ?? body["error"] ?? `HTTP ${res.status}`);
    pass("dry-run withdraw", `refused as expected: ${reason.slice(0, 120)}`);
  }
} catch (e) {
  fail("dry-run withdraw", (e as Error).message);
}

// --- B. 1Click pricing (live mainnet API, free paths) -------------------------
console.log("\nB. 1Click pricing (live)");
const op = sampleOperation();

// Mock/testnet USDT cannot enter the rail: 1Click lists mainnet chains only.
// A bare /test/i would false-positive on mainnet memecoins (TESTNEBULA is a
// nep141: mainnet contract), so match actual testnet markers instead.
const TESTNET_MARKERS =
  /testnet|\.test\.|sepolia|holesky|hoodi|fuji|amoy|80002|11155111|43113|84532|421614/i;
try {
  const res = await f(`${ONECLICK_URL}/v0/tokens`);
  const list = (await res.json()) as { assetId?: string; symbol?: string; blockchain?: string }[];
  const suspects = list.filter((t) =>
    TESTNET_MARKERS.test(`${t.blockchain}:${t.assetId ?? ""}:${t.symbol ?? ""}`),
  );
  if (!Array.isArray(list) || list.length === 0) {
    fail("GET /v0/tokens", "empty or shapeless token list");
  } else if (suspects.length > 0) {
    fail("GET /v0/tokens", `testnet-chain assets present: ${JSON.stringify(suspects).slice(0, 160)}`);
  } else {
    pass("GET /v0/tokens", `${list.length} assets, none on a testnet chain — no mock-USDT path exists`);
  }
} catch (e) {
  fail("GET /v0/tokens", (e as Error).message);
}

let quote: Awaited<ReturnType<OneClickRail["quote"]>> | undefined;
try {
  const rail = new OneClickRail({
    baseUrl: ONECLICK_URL,
    registry: AssetRegistry.known(),
    refundTo: op.refundTo,
    dry: true,
    fetchImpl: f,
  });
  quote = await rail.quote(op);
  if (quote.amountOut <= 0n || quote.amountIn <= 0n || !quote.quoteId) {
    fail("POST /v0/quote (dry)", "quote parsed but not sane");
    quote = undefined;
  } else {
    pass(
      "POST /v0/quote (dry)",
      `in=${quote.amountIn} out=${quote.amountOut}` +
        (quote.depositAddress ? "" : " (no deposit address: dry prices only)"),
    );
  }
} catch (e) {
  fail("POST /v0/quote (dry)", (e as Error).message);
}

// --- C. Real fund attempt on testnet (live refusal) ---------------------------
console.log("\nC. Funding attempt on testnet (live)");
if (!quote) {
  fail("fund()", "skipped: no live quote to fund against");
} else {
  const plan = signer.plan(op, quote);
  if (plan.route !== "intents") {
    fail("plan()", `expected intents route, got "${plan.route}"`);
  } else {
    pass("plan()", `route=intents token=${plan.token} amount=${plan.amount}`);
  }
  try {
    const funding = await signer.fund(op, quote, plan);
    if (funding.kind === "deposited") {
      // Testnet has no solvers: a deposit here would mean our classification
      // is lying, which is worse than any refusal.
      fail("fund()", `testnet reported a deposit (${funding.proof.txHash}) — investigate, do not trust`);
    } else if (funding.kind === "failed" && !funding.safeToRetry) {
      fail("fund()", `refused but claims funds may have moved: ${funding.reason}`);
    } else {
      const reason = funding.kind === "failed" ? funding.reason : funding.reason;
      pass("fund()", `${funding.kind} as expected on testnet: ${reason.slice(0, 140)}`);
    }
  } catch (e) {
    fail("fund()", `threw instead of classifying: ${(e as Error).message}`);
  }
}

// --- D. Full loop through the real API (simulated settlement) -----------------
console.log("\nD. Full pay-run loop, real API (simulated rail)");
const { server } = createApi({ auth: testAuth(), rail: new FakeRail(), signer: new FakeSigner() });
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const AUTH = { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}` };
const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const get = async (path: string) => {
  const res = await fetch(base + path, { headers: AUTH });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

try {
  for (const p of [
    { id: "ada", kind: "contractor", chain: "near", address: "ada.near" },
    { id: "shop", kind: "vendor", chain: "base", address: "0xshop" },
  ]) {
    await post("/v1/payees", {
      id: p.id,
      orgId: "org_1",
      kind: p.kind,
      displayName: p.id,
      destination: { chain: p.chain, asset: "usdc" },
      address: p.address,
      status: "approved",
      screening: "clear",
    });
  }
  await post("/v1/policies", {
    orgId: "org_1",
    rules: { ...defaultRules(), requireApprovalForNewPayee: false },
  });

  const run = await post("/v1/pay-runs", {
    orgId: "org_1",
    period: "2026-11",
    lines: [
      { payeeId: "ada", usdCents: 150_000 },
      { payeeId: "shop", usdCents: 250_000 },
    ],
  });
  if (run.status !== 201 || run.json["settledCents"] !== 150_000) {
    fail("pay run", `expected 150000 settled cents, got ${JSON.stringify(run.json).slice(0, 160)}`);
  } else {
    pass("pay run", "150000 settled, 1 line held for approval");
  }

  const approvalId = (run.json["approvals"] as string[])[0]!;
  const approved = await post(`/v1/approvals/${approvalId}/approve`, { decidedBy: "e2e" });
  const executed = await post(`/v1/approvals/${approvalId}/execute`, {});
  if (approved.status !== 200 || executed.status !== 200 || executed.json["status"] !== "executed") {
    fail("approve+execute", `approve=${approved.status} execute=${executed.status}`);
  } else {
    pass("approve+execute", `${approvalId} approved and executed`);
  }

  const summary = await get("/v1/pay-runs/run_1");
  const items = (summary.json as unknown as { items: { state: string; receipt?: { txHash: string } }[] }).items;
  if (summary.status !== 200 || !items.every((i) => i.state === "settled" && i.receipt?.txHash)) {
    fail("run summary", `lines not settled with receipts: ${JSON.stringify(summary.json).slice(0, 200)}`);
  } else {
    pass("run summary", "both lines settled, each with a tx receipt");
  }

  const ledger = await get("/v1/ledger?orgId=org_1");
  const books = ledger.json as unknown as { balanced: boolean; entries: unknown[] };
  if (!books.balanced || books.entries.length < 2) {
    fail("ledger", `balanced=${books.balanced} entries=${books.entries.length}`);
  } else {
    pass("ledger", `${books.entries.length} entries, trial balance nets to zero`);
  }

  const notes = await get("/v1/notifications?orgId=org_1");
  const kinds = (notes.json as unknown as { kind: string }[]).map((n) => n.kind);
  if (!kinds.includes("payee_paid") || !kinds.includes("approval_needed")) {
    fail("notifications", `missing events: ${kinds.join(",")}`);
  } else {
    pass("notifications", kinds.join(", "));
  }
} catch (e) {
  fail("local loop", (e as Error).message);
} finally {
  server.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log("  LIVE      OutLayer testnet wallet, policy, dry-run, fund refusal");
console.log("  LIVE      1Click token list + dry quote (mainnet API, free paths)");
console.log("  REAL      policy, approvals, ledger, receipts, notifications (local)");
console.log("  SIMULATED rail submit/poll + deposit broadcast (no testnet path exists)");
console.log("  NO FUNDS MOVED.");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ok: testnet E2E behaved exactly as testnet allows");
