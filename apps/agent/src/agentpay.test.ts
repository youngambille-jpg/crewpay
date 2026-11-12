import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTask, Payee, Policy } from "@crewpay/domain";
import { defaultRules } from "@crewpay/domain";
import { FakeAgentPay } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { payAgentTask } from "./agentpay.ts";

const AGENT: Payee = {
  id: "gpt-worker",
  orgId: "org_1",
  kind: "agent",
  displayName: "GPT Worker",
  destination: { chain: "near", asset: "usdc" },
  address: "agent.near",
  status: "approved",
  screening: "clear",
};

function policy(overrides: Partial<ReturnType<typeof defaultRules>> = {}): Policy {
  return {
    id: "pol_1",
    orgId: "org_1",
    version: 1,
    active: true,
    rules: { ...defaultRules(), requireApprovalForNewPayee: false, ...overrides },
  };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task_1",
    orgId: "org_1",
    payeeId: "gpt-worker",
    protocol: "x402",
    resourceUrl: "https://api.example.com/agent/infer",
    amountOut: 200_000n,
    usdCents: 20_000,
    destination: { chain: "near", asset: "usdc" },
    status: "open",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const noSleep = async () => {};

function deps(agentpay: FakeAgentPay, extra: Partial<Parameters<typeof payAgentTask>[2]> = {}) {
  return {
    agentpay,
    lookupPayee: (id: string) => (id === AGENT.id ? AGENT : undefined),
    payeeHasHistory: () => true,
    sleep: noSleep,
    ...extra,
  };
}

test("a small task pays and returns a terminal receipt", async () => {
  const agentpay = new FakeAgentPay();
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "paid");
  if (outcome.status !== "paid") return;
  assert.equal(outcome.receipt.txHash, "tx_op_task_task_1");
  assert.equal(outcome.receipt.network, "near:mainnet");
  assert.equal(outcome.journal.kind, "payment_settled");
});

test("the payout is journaled for the amount delivered, and balances", async () => {
  const agentpay = new FakeAgentPay();
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "paid");
  if (outcome.status !== "paid") return;
  const debit = outcome.journal.postings
    .filter((p) => p.direction === "debit")
    .reduce((s, p) => s + p.amount, 0n);
  const credit = outcome.journal.postings
    .filter((p) => p.direction === "credit")
    .reduce((s, p) => s + p.amount, 0n);
  assert.equal(debit, credit);
});

test("an agent payout over its per-kind cap is denied, like any other payout", async () => {
  // 500.00 against a 100.00 per-agent cap: the policy must see this as money,
  // not as a special agent path.
  const agentpay = new FakeAgentPay();
  const outcome = await payAgentTask(
    task({ usdCents: 50_000 }),
    policy({ perKindCents: { agent: 10_000 } }),
    deps(agentpay, { signer: new FakeSigner() }),
  );
  assert.equal(outcome.status, "denied");
  assert.equal(outcome.status === "denied" && outcome.decision.reasons[0]!.code, "PER_KIND_CAP");
  assert.equal(agentpay.settleCalls.length, 0, "a denied payout must not touch the facilitator");
});

test("a payout over the approval threshold is held back, not paid", async () => {
  const agentpay = new FakeAgentPay();
  const outcome = await payAgentTask(
    task({ usdCents: 50_000 }),
    policy({ approvalThresholdCents: 20_000 }),
    deps(agentpay, { signer: new FakeSigner() }),
  );
  assert.equal(outcome.status, "awaiting_approval");
  assert.equal(agentpay.settleCalls.length, 0);
});

test("a blocked payee is denied before any facilitator call", async () => {
  const agentpay = new FakeAgentPay();
  const blocked: Payee = { ...AGENT, status: "blocked" };
  const outcome = await payAgentTask(task(), policy(), {
    agentpay,
    lookupPayee: () => blocked,
    payeeHasHistory: () => true,
    sleep: noSleep,
  });
  assert.equal(outcome.status, "denied");
  assert.equal(agentpay.settleCalls.length, 0);
});

test("a pending settlement is retried with the same operation token", async () => {
  const agentpay = new FakeAgentPay({ pendingSettles: 1 });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "paid");
  // Both settle attempts reused the quote's token: re-quoting would have
  // abandoned the deposit already in flight.
  assert.equal(agentpay.settleCalls.length, 2);
  assert.equal(agentpay.settleCalls[0]!.operationToken, agentpay.settleCalls[1]!.operationToken);
});

test("a short deposit is retried on the same token until it settles", async () => {
  const agentpay = new FakeAgentPay({ incompleteSettles: 2 });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "paid");
  assert.equal(agentpay.settleCalls.length, 3);
  assert.equal(new Set(agentpay.settleCalls.map((c) => c.operationToken)).size, 1);
});

test("a short deposit that never clears escalates with the top-up it needs", async () => {
  // A retry cannot clear a short deposit on its own: the documented remedy is to
  // top the address up. Exhausting the budget must surface the address and the
  // token, not a generic "did not settle", or the money is stranded silently.
  const agentpay = new FakeAgentPay({ incompleteSettles: 99 });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "needs_review");
  assert.match(outcome.reason, /INCOMPLETE_DEPOSIT/);
  assert.match(outcome.reason, /top it up/);
  // The token is quoted once and reused: re-quoting would abandon a live deposit.
  assert.equal(new Set(agentpay.settleCalls.map((c) => c.operationToken)).size, 1);
});

test("a terminal settlement failure is not retried", async () => {
  const agentpay = new FakeAgentPay({ failSettles: true });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "failed");
  assert.equal(agentpay.settleCalls.length, 1, "a terminal failure must not be retried blindly");
});

test("a transient settlement failure is retried", async () => {
  const agentpay = new FakeAgentPay({ retryableSettles: true });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "failed");
  assert.equal(agentpay.settleCalls.length, 5, "should use the whole attempt budget");
});

test("settlement that never terminates escalates to a human", async () => {
  const agentpay = new FakeAgentPay({ pendingSettles: 99 });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "needs_review");
  assert.match(outcome.status === "needs_review" ? outcome.reason : "", /terminal state/);
});

test("funding that needs review stops before settle, so funds are not moved twice", async () => {
  const agentpay = new FakeAgentPay();
  const signer = new FakeSigner({ needsReviewOperationIds: ["op_task_task_1"] });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer }));
  assert.equal(outcome.status, "needs_review");
  assert.equal(agentpay.settleCalls.length, 0);
});

test("funding that fails cleanly reports failed", async () => {
  const agentpay = new FakeAgentPay();
  const signer = new FakeSigner({ retryableFailureOperationIds: ["op_task_task_1"] });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer }));
  assert.equal(outcome.status, "failed");
  assert.equal(agentpay.settleCalls.length, 0);
});

test("an unquotable route fails without settling", async () => {
  const agentpay = new FakeAgentPay({ failQuote: true });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "failed");
  assert.equal(agentpay.settleCalls.length, 0);
});

test("the receipt carries the quoted input amount, not the nominal one", async () => {
  // Ping demands a minimum origin delivery that can exceed the face amount.
  const agentpay = new FakeAgentPay({ amountIn: 260_000n });
  const outcome = await payAgentTask(task(), policy(), deps(agentpay, { signer: new FakeSigner() }));
  assert.equal(outcome.status, "paid");
  assert.equal(outcome.status === "paid" && outcome.receipt.amountIn, 260_000n);
});
