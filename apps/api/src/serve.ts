/**
 * Serve the control plane over HTTP with a seeded demo org, so the dashboard
 * has something real to read. This is the same `createApi` the tests and the
 * demo drive — it is not a mock.
 *
 * Two modes, chosen by `CREWPAY_MODE`:
 *
 *   demo (default) — the money path runs on `FakeRail`/`FakeSigner`, so it
 *     needs no network and no credentials and the dashboard always has data.
 *     The Connect, health, policy-compile and dry-run endpoints are still real,
 *     because those are what the demo is actually showing.
 *
 *   live — the money path runs on the real adapters: `OneClickRail` with dry
 *     quotes and `OutLayerSigner` against a custody wallet. A real payout then
 *     needs a funded mainnet wallet, which this demo does not have, so a run
 *     stops at `insufficient_balance` and says so. That is the honest outcome,
 *     not a bug.
 *
 * `PORT` defaults to 4000. `PING_API_KEY` and `OUTLAYER_API_KEY` are read from
 * the environment only, and are never logged.
 */
import { FakeRail, FakePingPay, FakeAgentPay, OneClickRail, AssetRegistry } from "@crewpay/rails";
import { FakeSigner, OutLayerSigner } from "@crewpay/signer";
import { createApi, type ApiDeps } from "./server.ts";
import { LiveServices } from "./live.ts";
import { ORG_ID, seedOrg, seedPayRun } from "./seed.ts";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";
const MODE = (process.env.CREWPAY_MODE ?? "demo") === "live" ? "live" : "demo";
const OUTLAYER_API_KEY = process.env["OUTLAYER_API_KEY"];

const pingpay = new FakePingPay({ webhookSecret: "whsec_dev" });
const live = new LiveServices(MODE);

/** The money path: real adapters in live mode, deterministic fakes otherwise. */
function moneyPath(): Pick<ApiDeps, "rail" | "signer"> {
  if (MODE === "live" && OUTLAYER_API_KEY) {
    return {
      rail: new OneClickRail({
        baseUrl: process.env["ONECLICK_BASE_URL"] ?? "https://1click.chaindefuser.com",
        registry: AssetRegistry.known(),
        refundTo: "crewpay.near",
        // A dry quote prices the corridor without minting a deposit address, so
        // it needs no partner key. The deposit address comes from the rail once
        // the wallet is funded.
        dry: true,
      }),
      signer: new OutLayerSigner({
        apiKey: OUTLAYER_API_KEY,
        ...(process.env["OUTLAYER_BASE_URL"]
          ? { baseUrl: process.env["OUTLAYER_BASE_URL"] }
          : {}),
      }),
    };
  }
  return {
    // Slow op 3 and hold op 2 for review so the run is not trivially all-green:
    // the dashboard must be able to show a mixed result.
    rail: new FakeRail({ slowOperationIds: ["run_1_op_3"] }),
    signer: new FakeSigner({ needsReviewOperationIds: ["run_1_op_2"] }),
  };
}

const { server } = createApi({
  ...moneyPath(),
  pingpay,
  agentpay: new FakeAgentPay({ pendingSettles: 1 }),
  live,
});

await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));

const base = `http://127.0.0.1:${PORT}`;
const call = async (path: string, method: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
};

await seedOrg(call);
const run = await seedPayRun(call);

// One invoice, so the invoices screen is not empty. Left open on purpose —
// a paid invoice arrives by webhook, which this process does not fake.
await call("/v1/invoices", "POST", {
  orgId: ORG_ID,
  customerId: "acme-corp",
  amount: 150_000,
  autoPayRun: { payeeId: "ada" },
});

console.log(`crewpay api on ${base} (mode: ${MODE})`);
console.log(`seeded ${ORG_ID}: ${run?.run?.id ?? "run"} · ${run?.settledCents ?? 0} cents settled`);
if (MODE === "live" && !OUTLAYER_API_KEY) {
  console.warn("live mode requested but OUTLAYER_API_KEY is unset; money path is fake");
}
