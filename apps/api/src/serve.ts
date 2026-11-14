/**
 * Serve the control plane over HTTP, live on testnet.
 *
 * No seed data, no fake rails: every figure comes from the real API, and money
 * moves as mock USDT on NEAR testnet through a server-held OutLayer testnet
 * wallet. The wallet's `wk_` key is persisted to `.data/testnet-wallet.json`
 * (0600, gitignored) so a restart reuses the same funded account instead of
 * orphaning the gas sent to it; set CREWPAY_TESTNET_STATE to move or disable
 * that file. The key never leaves this process otherwise.
 *
 * `PORT` defaults to 4000. `CREWPAY_API_TOKEN` is required (no anonymous
 * payroll). `PING_API_KEY` wires real PingPay checkout and Agent Pay; without
 * it those routes answer 400 until configured. Nothing here is simulated.
 */
import { AgentPayClient, PingPayClient, Relayer } from "@crewpay/rails";
import { resolve } from "node:path";
import { createApi, type ApiDeps } from "./server.ts";
import { LiveServices } from "./live.ts";
import { TestnetServices } from "./testnet.ts";
import type { AuthConfig } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

/**
 * The API holds payroll and the books, so it does not run open. A bearer token
 * is required and there is no fallback. `CREWPAY_ORG_ID` names the org that
 * token may act on.
 */
const API_TOKEN = process.env["CREWPAY_API_TOKEN"];
const TOKEN_ORG = process.env["CREWPAY_ORG_ID"] ?? "org_1";
if (!API_TOKEN) {
  console.error(
    "CREWPAY_API_TOKEN is not set. The API serves payroll and the books, so it " +
      "will not start without a token. Set one, e.g. CREWPAY_API_TOKEN=$(openssl rand -hex 32).",
  );
  process.exit(1);
}
const auth: AuthConfig = { tokens: new Map([[API_TOKEN, { orgId: TOKEN_ORG, label: TOKEN_ORG }]]) };

const live = new LiveServices();
const testnet = new TestnetServices({
  statePath: process.env["CREWPAY_TESTNET_STATE"] ?? resolve(process.cwd(), ".data/testnet-wallet.json"),
  // The cross-chain router prices an outbound corridor through this. It is a
  // keyless 1Click dry quote, so it needs no partner key and moves nothing.
  priceOutbound: live.crossChainPrice(),
});
const { account: testnetAccount, reused: testnetReused } = await testnet.register().catch((err: unknown) => {
  console.error(
    `Testnet wallet register failed (this API needs the network): ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
});
const adapters = testnet.adapters();
if (!adapters) {
  console.error("Testnet wallet missing right after register; refusing to start half-wired.");
  process.exit(1);
}

const PING_API_KEY = process.env["PING_API_KEY"];
const pingpay = PING_API_KEY
  ? new PingPayClient({
      publishableKey: PING_API_KEY,
      ...(process.env["PING_WEBHOOK_SECRET"] ? { webhookSecret: process.env["PING_WEBHOOK_SECRET"] } : {}),
    })
  : undefined;
const agentpay = PING_API_KEY
  ? new AgentPayClient({ apiKey: PING_API_KEY, refundTo: "crewpay.near" })
  : undefined;

// NEP-366 gas relayer. It sponsors gas for payees who hold no NEAR: the
// receiver allow-list is the testnet payee account, so the relayer can only
// forward a delegate action back to that account, never act as a chain-wide
// gas faucet. The testnet wallet cannot emit Action::Delegate, so a valid
// delegate action is assembled but not broadcast — the outcome says so.
const relayer = new Relayer({
  allowedReceivers: [testnetAccount ?? "crewpay.testnet"],
  allowedMethods: ["ft_transfer", "transfer"],
});

const deps: ApiDeps = {
  auth,
  rail: adapters.rail,
  signer: adapters.signer,
  relayer,
  ...(pingpay ? { pingpay } : {}),
  ...(agentpay ? { agentpay } : {}),
  live,
  testnet,
};
const { server } = createApi(deps);

await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
console.log(`crewpay api on http://${HOST}:${PORT} (live testnet)`);
console.log(
  `testnet wallet: ${testnetAccount} (${testnetReused ? "reused from state" : "freshly minted"})` +
    ` — needs testnet NEAR gas before it can pay`,
);
if (!PING_API_KEY) {
  console.warn("PING_API_KEY unset; invoices and agent payouts answer 400 until configured");
}
