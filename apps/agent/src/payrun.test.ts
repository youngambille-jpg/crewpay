import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Operation,
  type PayRunItem,
  type Payee,
  type Policy,
  corridor,
  defaultRules,
} from "@crewpay/domain";
import { FakeRail } from "@crewpay/rails";
import { FakeSigner } from "@crewpay/signer";
import { executeRun } from "./payrun.ts";

const BASE_USDC = { chain: "base", asset: "usdc" } as const;
const NEAR_USDC = { chain: "near", asset: "usdc" } as const;

function policy(overrides: Partial<Policy["rules"]> = {}): Policy {
  return {
    id: "pol_1",
    orgId: "org_1",
    version: 1,
    active: true,
    rules: { ...defaultRules(), requireApprovalForNewPayee: false, ...overrides },
  };
}

function payee(id: string, overrides: Partial<Payee> = {}): Payee {
  return {
    id,
    orgId: "org_1",
    kind: "contractor",
    displayName: id,
    destination: NEAR_USDC,
    address: `${id}.near`,
    status: "approved",
    screening: "clear",
    ...overrides,
  };
}

function line(id: string, payeeId: string, usdCents: number): { item: PayRunItem; operation: Operation } {
  const operation: Operation = {
    id,
    orgId: "org_1",
    payRunItemId: `item_${id}`,
    type: "payout",
    amount: { amount: BigInt(usdCents) * 10_000n, asset: "usdc" },
    usdCents,
    origin: BASE_USDC,
    destination: NEAR_USDC,
    corridor: corridor(BASE_USDC, NEAR_USDC),
    recipient: `${payeeId}.near`,
    refundTo: "crewpay.near",
    deadline: "2026-11-12T00:00:00.000Z",
  };
  const item: PayRunItem = {
    id: `item_${id}`,
    payRunId: "run_1",
    payeeId,
    amount: operation.amount,
    corridor: operation.corridor,
    operationId: id,
    state: "pending",
  };
  return { item, operation };
}

function deps(payees: Payee[], opts: ConstructorParameters<typeof FakeRail>[0] = {}) {
  const byId = new Map(payees.map((p) => [p.id, p]));
  return {
    rail: new FakeRail(opts),
    lookupPayee: (id: string) => byId.get(id),
    payeeHasHistory: () => true,
  };
}

test("settles an allowed run and writes a balanced journal per payment", async () => {
  const p = payee("ada");
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 150_000)], deps([p]));
  assert.equal(result.settledCents, 150_000);
  assert.equal(result.outcomes[0]?.settlement?.status, "settled");
  assert.equal(result.outcomes[0]?.journal?.kind, "payment_settled");
  assert.deepEqual(result.denied, []);
});

test("routes over-threshold items to approval instead of paying", async () => {
  const p = payee("ada");
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 250_000)], deps([p]));
  assert.deepEqual(result.awaitingApproval, ["op_1"]);
  assert.equal(result.settledCents, 0);
  assert.equal(result.outcomes[0]?.settlement, undefined);
});

test("denies out-of-policy items and never calls the rail", async () => {
  const p = payee("ada");
  const result = await executeRun(
    "org_1",
    policy({ maxPerTransactionCents: 100_000 }),
    [line("op_1", "ada", 150_000)],
    deps([p]),
  );
  assert.deepEqual(result.denied, ["op_1"]);
  assert.equal(result.outcomes[0]?.settlement, undefined);
});

test("the daily cap accumulates across settled items", async () => {
  const a = payee("a");
  const b = payee("b");
  const p = policy({ maxDailyCents: 200_000, approvalThresholdCents: 1_000_000 });
  const result = await executeRun(
    "org_1",
    p,
    [line("op_1", "a", 150_000), line("op_2", "b", 150_000)],
    deps([a, b]),
  );
  assert.deepEqual(result.denied, ["op_2"]);
  assert.equal(result.settledCents, 150_000);
});

test("a failed settlement is reported and not journaled", async () => {
  const p = payee("ada");
  const result = await executeRun(
    "org_1",
    policy(),
    [line("op_1", "ada", 150_000)],
    deps([p], { failOperationIds: ["op_1"] }),
  );
  assert.deepEqual(result.failed, ["op_1"]);
  assert.equal(result.outcomes[0]?.journal, undefined);
});

test("a pending settlement is polled to completion", async () => {
  const p = payee("ada");
  const result = await executeRun(
    "org_1",
    policy(),
    [line("op_1", "ada", 150_000)],
    deps([p], { slowOperationIds: ["op_1"] }),
  );
  assert.equal(result.outcomes[0]?.settlement?.status, "settled");
  assert.equal(result.settledCents, 150_000);
});

test("with a signer, a settled payment carries the deposit proof", async () => {
  const p = payee("ada");
  const d = { ...deps([p]), signer: new FakeSigner() };
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 150_000)], d);
  assert.equal(result.settledCents, 150_000);
  const funding = result.outcomes[0]?.funding;
  assert.equal(funding?.kind, "deposited");
  if (funding?.kind === "deposited") assert.equal(funding.proof.txHash, "0xdeposit_op_1");
});

test("a funding failure stops before submit and is reported as failed", async () => {
  const p = payee("ada");
  const d = {
    ...deps([p]),
    signer: new FakeSigner({ retryableFailureOperationIds: ["op_1"] }),
  };
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 150_000)], d);
  assert.deepEqual(result.failed, ["op_1"]);
  assert.equal(result.settledCents, 0);
  assert.equal(result.outcomes[0]?.settlement, undefined);
  assert.equal(result.outcomes[0]?.funding?.kind, "failed");
});

test("unknown fund state is escalated to needsReview, never to failed", async () => {
  const p = payee("ada");
  const d = { ...deps([p]), signer: new FakeSigner({ needsReviewOperationIds: ["op_1"] }) };
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 150_000)], d);
  assert.deepEqual(result.needsReview, ["op_1"]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.settledCents, 0);
  assert.equal(result.outcomes[0]?.settlement, undefined);
});

test("in-flight funding is escalated, not marked failed", async () => {
  const p = payee("ada");
  const d = { ...deps([p]), signer: new FakeSigner({ stuckOperationIds: ["op_1"] }) };
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 150_000)], d);
  assert.deepEqual(result.needsReview, ["op_1"]);
  assert.deepEqual(result.failed, []);
});

test("a non-retryable funding failure is still reported as failed", async () => {
  const p = payee("ada");
  const d = { ...deps([p]), signer: new FakeSigner({ unsafeFailureOperationIds: ["op_1"] }) };
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 150_000)], d);
  assert.deepEqual(result.failed, ["op_1"]);
  const funding = result.outcomes[0]?.funding;
  assert.equal(funding?.kind, "failed");
  if (funding?.kind === "failed") assert.equal(funding.safeToRetry, false);
});

test("a settlement still in flight after the poll budget is escalated", async () => {
  const p = payee("ada");
  // slow with more pending polls than the orchestrator's MAX_POLLS allows.
  const d = { ...deps([p], { slowOperationIds: ["op_1"], pendingPolls: 999 }) };
  const result = await executeRun("org_1", policy(), [line("op_1", "ada", 150_000)], d);
  assert.deepEqual(result.needsReview, ["op_1"]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.settledCents, 0);
});

test("the daily cap seeds from prior spend across runs", async () => {
  const p = payee("ada");
  const d = { ...deps([p]), spentTodayCents: 150_000 };
  const result = await executeRun(
    "org_1",
    policy({ maxDailyCents: 200_000, approvalThresholdCents: 1_000_000 }),
    [line("op_1", "ada", 150_000)],
    d,
  );
  assert.deepEqual(result.denied, ["op_1"]);
  assert.equal(result.settledCents, 0);
});
