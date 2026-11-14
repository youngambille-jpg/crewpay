/**
 * End-to-end mock-USDT payout on NEAR testnet.
 *
 * The flow the mainnet loop cannot run on testnet: quote the corridor with
 * Intents pricing, then pay the user directly in mock USDT (usdt.fakes.testnet)
 * from an OutLayer testnet wallet — no swap, no solvers needed. Policy,
 * approvals, ledger, receipts and notifications are the real production path;
 * only the rail and signer are the testnet pair.
 *
 * Funding is autonomous: a helper-funded testnet account supplies gas, the
 * wallet pays its own storage and mint calls, and the recipient defaults to a
 * fresh helper account — so a bare run pays end to end with no human input.
 * Pass RECIPIENT to pay a real testnet user instead, and OUTLAYER_WK_KEY to
 * reuse an already-funded wallet across runs. No key is ever logged.
 *
 *   npm run e2e:testnet-payout
 *   RECIPIENT=<you.testnet> npm run e2e:testnet-payout
 */
import type { AddressInfo } from "node:net";
import { defaultRules } from "@crewpay/domain";
import { AssetRegistry, OneClickRail, TestnetRail } from "@crewpay/rails";
import { OutLayerClient, TestnetSigner, isTerminalStatus } from "@crewpay/signer";
import { createApi } from "../apps/api/src/server.ts";
import { TEST_TOKEN, testAuth } from "../apps/api/src/auth.ts";
import {
  broadcastTransfer,
  genKeypair,
  helperCreateAccount,
  selfTest,
  type TestKeypair,
} from "./testnet-fund.ts";

const ONECLICK_URL = process.env["ONECLICK_BASE_URL"] ?? "https://1click.chaindefuser.com";
const OUTLAYER_TESTNET = process.env["OUTLAYER_TESTNET_URL"] ?? "https://testnet-api.outlayer.ai";
const NEAR_RPC_URL = process.env["NEAR_RPC_URL"] ?? "https://rpc.testnet.fastnear.com";
const TIMEOUT_MS = 30_000;
const USDT = "usdt.fakes.testnet";
const MIN_GAS_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
const STORAGE_YOCTO = "1250000000000000000000"; // 0.00125 NEAR
const MINT_BASE = "10000000"; // 10 USDT.e for the wallet
const PAYOUT_CENTS = Number(process.env["PAYOUT_USDCENTS"] ?? 100);
const PAYOUT_BASE = BigInt(PAYOUT_CENTS) * 10_000n;
const FUND_TIMEOUT_MS = Number(process.env["FUND_TIMEOUT_MIN"] ?? 20) * 60_000;

const RECIPIENT = process.env["RECIPIENT"] ?? "";

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
const f = timeoutFetch();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RpcCall = { ok: true; value: unknown } | { ok: false; error: string };

async function rpcCall(contract: string, method: string, args: Record<string, unknown>): Promise<RpcCall> {
  try {
    const res = await f(NEAR_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "e2e",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contract,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
    });
    const body = (await res.json()) as Record<string, any>;
    if (body["error"]) {
      const info = body["error"].cause?.info;
      return { ok: false, error: String(info?.error_message ?? body["error"].name ?? "rpc error") };
    }
    // Contract panics (e.g. balance of an unregistered account) arrive as a
    // 200 with result.error, not a top-level error.
    if (body["result"]?.["error"] || body["result"]?.["result"] === undefined) {
      return { ok: false, error: String(body["result"]?.["error"] ?? "unreadable result").slice(0, 160) };
    }
    return { ok: true, value: JSON.parse(Buffer.from(body["result"]["result"]).toString("utf8")) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function viewAccount(account: string): Promise<{ exists: boolean; yocto: bigint }> {
  try {
    const res = await f(NEAR_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "e2e",
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: account },
      }),
    });
    const body = (await res.json()) as Record<string, any>;
    if (body["error"]) return { exists: false, yocto: 0n };
    return { exists: true, yocto: BigInt(body["result"]["amount"] ?? "0") };
  } catch {
    return { exists: false, yocto: 0n };
  }
}

async function usdtBalanceOf(account: string): Promise<bigint> {
  const r = await rpcCall(USDT, "ft_balance_of", { account_id: account });
  return r.ok && typeof r.value === "string" ? BigInt(r.value) : 0n;
}

/**
 * Registration is not observable on this minimal token: it has no
 * ft_storage_balance_of view, and ft_balance_of returns "0" even for
 * unregistered accounts. So deposits are attempted unconditionally (once each)
 * and the payout tx itself is the verdict — a missing registration fails there.
 */

/** Follow an OutLayer request row to a terminal status. */
async function awaitRow(
  client: OutLayerClient,
  row: { request_id?: string; status: string },
): Promise<{ status: string; reason?: string }> {
  let current = row as { request_id?: string; status: string; result?: Record<string, unknown> };
  for (let i = 0; i < 30; i += 1) {
    const st = String(current.status);
    if (isTerminalStatus(st)) {
      const reason = current.result?.["reason"];
      return { status: st, ...(typeof reason === "string" ? { reason } : {}) };
    }
    if (!current.request_id) return { status: st };
    await sleep(2000);
    try {
      current = (await client.getRequest(current.request_id)) as typeof current;
    } catch {
      return { status: "read-failed" };
    }
  }
  return { status: "timeout" };
}

console.log(`CrewPay testnet payout\n  amount: ${PAYOUT_CENTS} cents (${PAYOUT_BASE} base units USDT.e)`);

// --- A. Wallet (fresh, or reused across runs) ---------------------------------
console.log("\nA. Testnet wallet");
let apiKey = process.env["OUTLAYER_WK_KEY"] ?? "";
let walletAccount = "";
if (apiKey) {
  const probe = new OutLayerClient({ apiKey, baseUrl: OUTLAYER_TESTNET, fetchImpl: f });
  try {
    walletAccount = (await probe.address()).address;
    pass("wallet", `reusing funded wallet ${walletAccount} from OUTLAYER_WK_KEY`);
  } catch (e) {
    fail("wallet", `OUTLAYER_WK_KEY rejected: ${(e as Error).message}`);
  }
} else {
  try {
    const res = await f(`${OUTLAYER_TESTNET}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok || typeof body["api_key"] !== "string" || typeof body["near_account_id"] !== "string") {
      fail("wallet", `register failed: HTTP ${res.status}`);
    } else {
      apiKey = body["api_key"] as string;
      walletAccount = body["near_account_id"] as string;
      pass("wallet", `fresh throwaway wallet ${walletAccount} (key in memory only)`);
    }
  } catch (e) {
    fail("wallet", (e as Error).message);
  }
}
if (!apiKey || !walletAccount || failures > 0) {
  console.error("Cannot continue without a wallet; aborting.");
  process.exit(1);
}
const client = new OutLayerClient({ apiKey, baseUrl: OUTLAYER_TESTNET, fetchImpl: f });
const runTag = `e2e-${Date.now()}`;

// --- B. Funding: autonomous first, human wait as fallback ----------------------
console.log("\nB. Funding");
const HELPER_URL = process.env["HELPER_URL"] ?? "https://helper.testnet.near.org";

try {
  selfTest();
  pass("signer", "local transfer encoding self-checks");
} catch (e) {
  fail("signer", (e as Error).message);
}

// A helper-funded account doubles as gas source; it is also the default
// recipient, so a bare run pays end to end with no human input.
let gasAccount = "";
let gasKp: TestKeypair | undefined;
if (failures === 0) {
  const kp = genKeypair();
  const name = `e2e-gas-${Date.now()}.testnet`;
  const created = await helperCreateAccount(HELPER_URL, f, name, kp.publicKeyNear);
  // Creation answers optimistically; wait for finality before believing it.
  let seen = await viewAccount(name);
  for (let i = 0; i < 10 && !(seen.exists && seen.yocto > 0n); i += 1) {
    await sleep(3000);
    seen = await viewAccount(name);
  }
  if (created.ok && seen.exists && seen.yocto > 0n) {
    gasAccount = name;
    gasKp = kp;
    pass("helper account", `${name} holds ${seen.yocto} yocto`);
  } else {
    console.log(`  helper account ${name} not visible (${created.detail.slice(0, 100)}); manual funding wait below`);
  }
}

const recipient = RECIPIENT || gasAccount;
if (!recipient) {
  fail("recipient", "no RECIPIENT set and no helper account; nothing to pay");
  console.error("Set RECIPIENT=<account.testnet> and re-run.");
  process.exit(1);
}
console.log(`  recipient: ${recipient}`);

// Move gas to the wallet so it exists on-chain and can pay its own way.
if (gasKp && gasAccount) {
  const w = await viewAccount(walletAccount);
  if (!w.exists || w.yocto < MIN_GAS_YOCTO) {
    const sent = await broadcastTransfer(
      NEAR_RPC_URL,
      f,
      gasKp,
      gasAccount,
      walletAccount,
      300_000_000_000_000_000_000_000n,
    );
    if (sent.ok) pass("gas transfer", `0.3 NEAR -> wallet (tx ${sent.txHash})`);
    else fail("gas transfer", sent.error);
  } else {
    pass("gas transfer", "wallet already holds gas (reused key)");
  }
}

async function outlayerCall(
  label: string,
  method: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { gas?: string; deposit?: string },
): Promise<boolean> {
  try {
    const row = await client.callContract(USDT, method, args, `${runTag}-${key}`, opts);
    const done = await awaitRow(client, row);
    console.log(`    ${label}: ${done.status}${done.reason ? ` (${done.reason})` : ""}`);
    return done.status === "success";
  } catch (e) {
    console.log(`    ${label} threw: ${String(e).slice(0, 140)}`);
    return false;
  }
}

// Self-setup attempts run inside the wait below: gas finality lags the
// transfer, so acting the moment broadcast succeeds is acting too early.
let storageTried = false;
let mintTried = false;
let recipientRegTried = false;

const deadline = Date.now() + FUND_TIMEOUT_MS;
let lastLine = "";
async function funded(): Promise<{ gas: boolean; usdt: boolean; recipient: boolean; yocto: bigint; usdtBal: bigint }> {
  const acct = await viewAccount(walletAccount);
  const gas = acct.exists && acct.yocto >= MIN_GAS_YOCTO;
  const balance = await usdtBalanceOf(walletAccount);
  const usdt = balance >= PAYOUT_BASE;
  return { gas, usdt, recipient: recipientRegTried, yocto: acct.yocto, usdtBal: balance };
}

let state = await funded();
while (Date.now() < deadline && !(state.gas && state.usdt && state.recipient)) {
  const line =
    `  gas=${state.gas ? "ok" : "WAITING"}(${state.yocto}) ` +
    `wallet-usdt=${state.usdt ? "ok" : "WAITING"}(${state.usdtBal}) ` +
    `recipient-registered=${state.recipient ? "ok" : "WAITING"}`;
  if (line !== lastLine) {
    console.log(line);
    lastLine = line;
    if (!state.gas) console.log(`    -> send testnet NEAR to ${walletAccount}`);
    if (state.gas && !state.usdt) {
      console.log(`    -> send >= ${PAYOUT_BASE} USDT.e (${USDT}) to ${walletAccount}`);
    }
    if (!state.recipient) {
      console.log(`    -> ${recipient} must register on ${USDT} (one storage deposit from its wallet)`);
    }
  }
  // One attempt per step, only once gas is visible. Mint waits a full poll
  // after the storage attempt so the deposit is final first. Anything still
  // missing after that is a human top-up, which the loop keeps waiting for.
  const storageWasTried = storageTried;
  if (state.gas && !storageTried) {
    storageTried = true;
    await outlayerCall("storage_deposit(self)", "storage_deposit", { account_id: walletAccount }, "storage", {
      deposit: STORAGE_YOCTO,
    });
  }
  if (state.gas && storageWasTried && !mintTried && (await usdtBalanceOf(walletAccount)) < PAYOUT_BASE) {
    mintTried = true;
    // account_id deserializes (proven live); receiver_id kept as fallback.
    // The mint takes no attached deposit (it panics on even 1 yocto).
    const minted =
      ((await outlayerCall(
        "mint(account_id)",
        "mint",
        { account_id: walletAccount, amount: MINT_BASE },
        "mint-0",
        { gas: "100000000000000", deposit: "0" },
      )) &&
        (await usdtBalanceOf(walletAccount)) >= PAYOUT_BASE) ||
      ((await outlayerCall(
        "mint(receiver_id)",
        "mint",
        { receiver_id: walletAccount, amount: MINT_BASE },
        "mint-1",
        { gas: "100000000000000", deposit: "0" },
      )) &&
        (await usdtBalanceOf(walletAccount)) >= PAYOUT_BASE);
    if (!minted) {
      await sleep(10_000);
      if ((await usdtBalanceOf(walletAccount)) < PAYOUT_BASE) {
        console.log("    mint did not land; waiting for a manual USDT top-up instead");
      }
    }
  }
  if (state.gas && !recipientRegTried) {
    recipientRegTried = true;
    await outlayerCall("storage_deposit(recipient)", "storage_deposit", { account_id: recipient }, "storage-r", {
      deposit: STORAGE_YOCTO,
    });
  }
  await sleep(15_000);
  state = await funded();
}

if (!(state.gas && state.usdt && state.recipient)) {
  fail(
    "funding",
    `timed out waiting: gas=${state.gas} wallet-usdt=${state.usdt} recipient=${state.recipient}`,
  );
  console.error("Fund the wallet and re-run (a fresh wallet is minted each run).");
  process.exit(1);
}
pass("funding", "wallet holds gas + USDT.e, recipient is registered");
const recipientBefore = await usdtBalanceOf(recipient);

// --- C. Intents pricing for the corridor (live, informational) -----------------
console.log("\nC. Intents quote (live pricing)");
const priceRail = new OneClickRail({
  baseUrl: ONECLICK_URL,
  registry: AssetRegistry.known(),
  // The priced origin is EVM, so the refund address must be EVM too.
  refundTo: "0x4200000000000000000000000000000000000006",
  dry: true,
  fetchImpl: f,
});
const priceOp = {
  id: "e2e_price",
  orgId: "e2e",
  type: "payout",
  amount: { amount: PAYOUT_BASE, asset: "usdc" },
  usdCents: PAYOUT_CENTS,
  origin: { chain: "base", asset: "usdc" },
  destination: { chain: "near", asset: "usdc" },
  corridor: "base:usdc>near:usdc",
  recipient,
  refundTo: "0x4200000000000000000000000000000000000006",
  deadline: new Date(Date.now() + 3_600_000).toISOString(),
} as const;
let quoted = false;
for (let attempt = 0; attempt < 2 && !quoted; attempt += 1) {
  try {
    const q = await priceRail.quote(priceOp);
    pass("dry quote", `Intents prices $${(PAYOUT_CENTS / 100).toFixed(2)} at in=${q.amountIn} out=${q.amountOut}`);
    quoted = true;
  } catch (e) {
    if (attempt === 0) {
      await sleep(5000);
    } else {
      console.warn(`  warn dry quote — ${(e as Error).message} (informational; execution uses 1:1 testnet amounts)`);
    }
  }
}

// --- D. The payout, through the real loop --------------------------------------
console.log("\nD. Mock-USDT payout (live testnet rail)");
const { server } = createApi({
  auth: testAuth(),
  rail: new TestnetRail({ senderAccount: walletAccount, rpcUrl: NEAR_RPC_URL, fetchImpl: f }),
  signer: new TestnetSigner({ apiKey, baseUrl: OUTLAYER_TESTNET, fetchImpl: f, maxPolls: 30, pollIntervalMs: 2000 }),
});
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

let receiptTx = "";
try {
  await post("/v1/payees", {
    id: "user",
    orgId: "org_1",
    kind: "contractor",
    displayName: "testnet user",
    destination: { chain: "near", asset: "usdt" },
    address: recipient,
    status: "approved",
    screening: "clear",
  });
  await post("/v1/policies", {
    orgId: "org_1",
    rules: { ...defaultRules(), requireApprovalForNewPayee: false },
  });
  const run = await post("/v1/pay-runs", {
    orgId: "org_1",
    period: "2026-11",
    origin: { chain: "near", asset: "usdt" },
    lines: [{ payeeId: "user", usdCents: PAYOUT_CENTS }],
  });
  if (run.status !== 201 || run.json["settledCents"] !== PAYOUT_CENTS) {
    let diag = JSON.stringify(run.json).slice(0, 200);
    try {
      const ops = await get("/v1/operations?orgId=org_1");
      const rows = ops.json as unknown as {
        operation: { id: string };
        record?: { decision: string; reasonCodes: string[]; status: string; note?: string };
      }[];
      const rec = rows.find((r) => r.operation.id === "run_1_op_1")?.record;
      if (rec) {
        diag =
          `decision=${rec.decision} reasons=${rec.reasonCodes.join(",") || "-"} ` +
          `status=${rec.status} note=${rec.note ?? "-"}`;
      }
    } catch {
      // Fall back to the raw response.
    }
    fail("pay run", `expected ${PAYOUT_CENTS} settled cents: ${diag}`);
  } else {
    pass("pay run", `${PAYOUT_CENTS} cents settled through the testnet rail`);
  }
  const summary = await get("/v1/pay-runs/run_1");
  const items = (summary.json as unknown as { items: { state: string; receipt?: { txHash: string } }[] }).items;
  if (summary.status === 200 && items[0]?.state === "settled" && items[0]?.receipt?.txHash) {
    receiptTx = items[0].receipt.txHash;
    pass("receipt", `tx ${receiptTx}`);
  } else {
    fail("receipt", `line not settled with a tx: ${JSON.stringify(summary.json).slice(0, 200)}`);
  }
  const ledger = await get("/v1/ledger?orgId=org_1");
  const books = ledger.json as unknown as { balanced: boolean; entries: unknown[] };
  if (books.balanced && books.entries.length >= 1) {
    pass("ledger", `${books.entries.length} entr${books.entries.length === 1 ? "y" : "ies"}, balanced`);
  } else {
    fail("ledger", `balanced=${books.balanced} entries=${books.entries.length}`);
  }
} catch (e) {
  fail("payout loop", (e as Error).message);
} finally {
  server.close();
}

// --- E. Independent on-chain verification ---------------------------------------
console.log("\nE. Recipient balance check (live RPC)");
const recipientAfter = await usdtBalanceOf(recipient);
const delta = recipientAfter - recipientBefore;
if (delta >= PAYOUT_BASE) {
  pass("balance delta", `${recipient} gained ${delta} base units USDT.e (expected ${PAYOUT_BASE})`);
} else {
  fail("balance delta", `${recipient} gained ${delta}, expected ${PAYOUT_BASE}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (receiptTx) console.log(`  payout tx: ${receiptTx} (look it up on a NEAR testnet explorer)`);
console.log(
  failures === 0
    ? "  MOCK FUNDS MOVED on testnet; nothing mainnet was touched."
    : "  NO PAYOUT COMPLETED; see failures above.",
);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ok: mock-USDT payout settled end to end on testnet");
