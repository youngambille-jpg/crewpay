/**
 * End-to-end demo: seed an org, then run a pay run through the API and print
 * the result. Uses the in-memory FakeRail so it runs with no network and no
 * credentials. Run with `npm run demo`.
 */
import type { AddressInfo } from "node:net";
import { FakeRail, FakePingPay, FakeAgentPay } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { defaultRules } from "@crewpay/domain";
import { createApi } from "./server.ts";

const pingpay = new FakePingPay({ webhookSecret: "whsec_demo" });
const { server } = createApi({
  rail: new FakeRail({ slowOperationIds: ["run_1_op_3"] }),
  signer: new FakeSigner({ needsReviewOperationIds: ["run_1_op_2"] }),
  pingpay,
  agentpay: new FakeAgentPay({ pendingSettles: 1 }),
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

// The same policy compiled into the manifest we hand the custody wallet's
// owner, with the rules OutLayer cannot enforce called out.
const manifest = await (
  await fetch(`${base}/v1/manifest?orgId=org_1&approvers=owner.near&threshold=1`)
).json();
console.log("manifest:", JSON.stringify(manifest, null, 2));

// Invoice flow: bill a customer, then let Ping's webhook settle it into a pay
// run. The invoice is billed at 1500.00, under the approval threshold.
const invoice = (await post("/v1/invoices", {
  orgId: "org_1",
  customerId: "acme",
  amount: 150_000,
  autoPayRun: { payeeId: "ada" },
})) as Record<string, unknown>;
console.log("invoice:", JSON.stringify(invoice, null, 2));

const signed = pingpay.signEvent({
  id: "evt_demo_1",
  type: "checkout.session.completed",
  resourceId: invoice["checkoutSessionId"],
});
const settled = await (
  await fetch(`${base}/v1/webhooks/pingpay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ping-signature": String(signed.headers.signature),
      "x-ping-timestamp": String(signed.headers.timestamp),
    },
    body: signed.body,
  })
).json();
console.log("invoice settled by webhook:", JSON.stringify(settled, null, 2));

// Agent task payout: an agent served a 402-protected resource and is owed for
// it. The payout goes through the same policy engine as a payroll line, then
// settles over x402 (quote -> deposit -> settle) with the same token on retry.
const agentTask = await post("/v1/agent-tasks", {
  orgId: "org_1",
  payeeId: "gpt-worker",
  resourceUrl: "https://api.example.com/agent/infer",
  amountOut: "200000",
  usdCents: 20_000,
  description: "batch inference job",
});
console.log("agent task paid:", JSON.stringify(agentTask, null, 2));

const exports = await (
  await fetch(`${base}/v1/exports/agent-payments?orgId=org_1`)
).json();
console.log("1099-style export:", JSON.stringify(exports, null, 2));

server.close();
