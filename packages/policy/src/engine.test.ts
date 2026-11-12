import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Operation,
  type Payee,
  type Policy,
  corridor,
  defaultRules,
} from "@crewpay/domain";
import { evaluate, isPayable, type DecisionContext } from "./engine.ts";

const BASE_USDC = { chain: "base", asset: "usdc" } as const;
const NEAR_USDC = { chain: "near", asset: "usdc" } as const;

function policy(overrides: Partial<Policy["rules"]> = {}): Policy {
  return {
    id: "pol_1",
    orgId: "org_1",
    version: 7,
    active: true,
    rules: { ...defaultRules(), ...overrides },
  };
}

function payee(overrides: Partial<Payee> = {}): Payee {
  return {
    id: "pay_1",
    orgId: "org_1",
    kind: "contractor",
    displayName: "Ada",
    destination: NEAR_USDC,
    address: "ada.near",
    status: "approved",
    screening: "clear",
    ...overrides,
  };
}

function op(usdCents: number, overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op_1",
    orgId: "org_1",
    type: "payout",
    amount: { amount: BigInt(usdCents) * 10_000n, asset: "usdc" },
    usdCents,
    origin: BASE_USDC,
    destination: NEAR_USDC,
    corridor: corridor(BASE_USDC, NEAR_USDC),
    recipient: "ada.near",
    refundTo: "crewpay.near",
    deadline: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    payee: payee(),
    spentTodayCents: 0,
    payeeHasHistory: true,
    hour: 12,
    ...overrides,
  };
}

test("allows a normal in-policy payout", () => {
  const r = evaluate(op(150_000), policy(), ctx());
  assert.equal(r.decision, "allow");
  assert.deepEqual(r.reasons, []);
  assert.equal(r.policyVersion, 7);
});

test("requires approval above the threshold", () => {
  const r = evaluate(op(250_000), policy(), ctx());
  assert.equal(r.decision, "allow_with_approval");
  assert.ok(r.reasons.some((x) => x.code === "APPROVAL_THRESHOLD"));
  assert.ok(isPayable(r));
});

test("denies above the per-transaction cap even if approval could apply", () => {
  const r = evaluate(op(600_000), policy(), ctx());
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "PER_TX_CAP"));
  assert.ok(!isPayable(r));
});

test("denies when the daily cap would be exceeded", () => {
  const r = evaluate(op(150_000), policy(), ctx({ spentTodayCents: 4_900_000 }));
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "DAILY_CAP"));
});

test("denies an unknown payee", () => {
  const r = evaluate(op(10_000), policy(), ctx({ payee: undefined }));
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "PAYEE_UNKNOWN"));
});

test("denies a blocked payee", () => {
  const r = evaluate(op(10_000), policy(), ctx({ payee: payee({ status: "blocked" }) }));
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "PAYEE_BLOCKED"));
});

test("requires approval for a payee that is not yet approved", () => {
  const r = evaluate(op(10_000), policy(), ctx({ payee: payee({ status: "draft" }) }));
  assert.equal(r.decision, "allow_with_approval");
  assert.ok(r.reasons.some((x) => x.code === "PAYEE_NOT_APPROVED"));
});

test("denies on a screening hit", () => {
  const r = evaluate(op(10_000), policy(), ctx({ payee: payee({ screening: "hit" }) }));
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "SCREENING_HIT"));
});

test("denies a corridor outside the allowlist", () => {
  const p = policy({ allowedCorridors: ["base:usdc>arbitrum:usdc"] });
  const r = evaluate(op(10_000), p, ctx());
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "CORRIDOR_NOT_ALLOWED"));
});

test("denies a destination asset outside the allowlist", () => {
  const p = policy({ allowedAssets: ["usdc"] });
  const r = evaluate(
    op(10_000, { destination: { chain: "near", asset: "wif" }, corridor: "base:usdc>near:wif" }),
    p,
    ctx(),
  );
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "ASSET_NOT_ALLOWED"));
});

test("applies a per-kind cap (agent payees are capped tighter)", () => {
  const p = policy({ perKindCents: { agent: 50_000 }, approvalThresholdCents: 1_000_000 });
  const r = evaluate(op(80_000), p, ctx({ payee: payee({ kind: "agent" }) }));
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.some((x) => x.code === "PER_KIND_CAP"));
});

test("requires approval for a brand-new payee", () => {
  const r = evaluate(op(10_000), policy(), ctx({ payeeHasHistory: false }));
  assert.equal(r.decision, "allow_with_approval");
  assert.ok(r.reasons.some((x) => x.code === "NEW_PAYEE"));
});

test("schedule window supports overnight ranges", () => {
  const p = policy({ schedule: { fromHour: 22, toHour: 6 } });
  assert.equal(evaluate(op(10_000), p, ctx({ hour: 23 })).decision, "allow");
  assert.equal(evaluate(op(10_000), p, ctx({ hour: 3 })).decision, "allow");
  const outside = evaluate(op(10_000), p, ctx({ hour: 12 }));
  assert.equal(outside.decision, "allow_with_approval");
  assert.ok(outside.reasons.some((x) => x.code === "SCHEDULE"));
});

test("is deterministic for identical inputs", () => {
  const a = evaluate(op(123_456), policy(), ctx());
  const b = evaluate(op(123_456), policy(), ctx());
  assert.deepEqual(a, b);
});

test("denials take precedence over approval reasons", () => {
  const p = policy({ allowedAssets: ["usdc"] });
  const r = evaluate(
    op(250_000, { destination: { chain: "near", asset: "wif" }, corridor: "base:usdc>near:wif" }),
    p,
    ctx({ payeeHasHistory: false }),
  );
  assert.equal(r.decision, "deny");
});
