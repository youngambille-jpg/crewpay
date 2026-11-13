/**
 * Serve the control plane over HTTP with a seeded demo org, so the dashboard
 * has something real to read. This is the same `createApi` the tests and the
 * demo drive — it is not a mock. Runs on FakeRail/FakeSigner by default, so it
 * needs no network and no credentials.
 *
 * `PORT` defaults to 4000. `PING_API_KEY` is read from the environment only if
 * you want the live PingPay paths; it is never logged.
 */
import { FakeRail, FakePingPay, FakeAgentPay } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { createApi } from "./server.ts";
import { ORG_ID, seedOrg, seedPayRun } from "./seed.ts";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

const pingpay = new FakePingPay({ webhookSecret: "whsec_dev" });

const { server } = createApi({
  // Slow op 3 and hold op 2 for review so the run is not trivially all-green:
  // the dashboard must be able to show a mixed result.
  rail: new FakeRail({ slowOperationIds: ["run_1_op_3"] }),
  signer: new FakeSigner({ needsReviewOperationIds: ["run_1_op_2"] }),
  pingpay,
  agentpay: new FakeAgentPay({ pendingSettles: 1 }),
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

console.log(`crewpay api on ${base}`);
console.log(`seeded ${ORG_ID}: ${run?.run?.id ?? "run"} · ${run?.settledCents ?? 0} cents settled`);
