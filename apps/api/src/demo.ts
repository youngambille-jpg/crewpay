/**
 * End-to-end demo: seed an org, then run a pay run through the API and print
 * the result. Uses the in-memory FakeRail so it runs with no network and no
 * credentials. Run with `npm run demo`.
 */
import type { AddressInfo } from "node:net";
import { FakeRail } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";

const { server } = createApi({
  rail: new FakeRail({ slowOperationIds: ["run_1_op_3"] }),
  signer: new FakeSigner({ needsReviewOperationIds: ["run_1_op_2"] }),
});

await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
};

const payees = [
  { id: "ada", kind: "contractor", destination: { chain: "near", asset: "usdc" }, address: "ada.near" },
  { id: "linus", kind: "contractor", destination: { chain: "arbitrum", asset: "usdc" }, address: "0xlinus" },
  { id: "shopify-agency", kind: "vendor", destination: { chain: "base", asset: "usdc" }, address: "0xagency" },
  { id: "gpt-worker", kind: "agent", destination: { chain: "near", asset: "usdc" }, address: "agent.near" },
];

for (const p of payees) {
  await post("/v1/payees", {
    orgId: "org_1",
    displayName: p.id,
    status: "approved",
    screening: "clear",
    ...p,
  });
}

await post("/v1/policies", {
  orgId: "org_1",
  rules: {
    ...defaultRules(),
    requireApprovalForNewPayee: false,
    approvalThresholdCents: 200_000,
    perKindCents: { agent: 50_000 },
  },
});

const result = await post("/v1/pay-runs", {
  orgId: "org_1",
  period: "2026-11",
  lines: [
    { payeeId: "ada", usdCents: 150_000 },
    { payeeId: "linus", usdCents: 120_000 },
    { payeeId: "shopify-agency", usdCents: 250_000 }, // above threshold -> approval
    { payeeId: "gpt-worker", usdCents: 80_000 }, // agent kind cap -> denied
  ],
});

console.log("pay run:", JSON.stringify(result, null, 2));

// The vendor is over the threshold, so it opened an approval instead of paying.
// A human decides, then the approved operation executes.
const run = result as { approvals: string[] };
const approvalId = run.approvals[0]!;

const inbox = await (await fetch(`${base}/v1/approvals?orgId=org_1`)).json();
console.log("inbox:", JSON.stringify(inbox, null, 2));

const decided = await post(`/v1/approvals/${approvalId}/approve`, { decidedBy: "owner@acme" });
console.log("approved:", JSON.stringify(decided, null, 2));

const executed = await post(`/v1/approvals/${approvalId}/execute`, {});
console.log("executed:", JSON.stringify(executed, null, 2));

server.close();
