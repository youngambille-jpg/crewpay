import { test } from "node:test";
import assert from "node:assert/strict";
import type { Operation } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import { CrossChainRail, isUnreachable, UNREACHABLE_REASON } from "./crosschain.ts";
import { FakeRail } from "./fake.ts";
import type { SettlementRail } from "./settlement.ts";

const NEAR_USDT = { chain: "near", asset: "usdt" } as const;
const BASE_USDC = { chain: "base", asset: "usdc" } as const;

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op_1",
    orgId: "org_1",
    type: "payout",
    amount: { amount: 100_000_000n, asset: "usdt" },
    usdCents: 10_000,
    origin: NEAR_USDT,
    destination: NEAR_USDT,
    corridor: corridor(NEAR_USDT, NEAR_USDT),
    recipient: "ada.testnet",
    refundTo: "crewpay.testnet",
    deadline: "2026-11-12T04:00:00.000Z",
    ...overrides,
  };
}

test("a NEAR corridor is settled by the NEAR rail, unchanged", async () => {
  const rail = new CrossChainRail({ nearRail: new FakeRail(), treasury: NEAR_USDT });
  const operation = op();
  const quote = await rail.quote(operation);
  const submitted = await rail.submit(operation, quote, { txHash: "tx_near" });
  assert.equal(submitted.status, "settled");
  assert.equal(isUnreachable(submitted), false);
  const polled = await rail.poll(operation.id, quote);
  assert.equal(polled.status, "settled");
  assert.equal(isUnreachable(polled), false);
});

test("a corridor to another chain fails by name, not as a settlement", async () => {
  const rail = new CrossChainRail({ nearRail: new FakeRail(), treasury: NEAR_USDT });
  const operation = op({ destination: BASE_USDC, corridor: corridor(NEAR_USDT, BASE_USDC) });
  const quote = await rail.quote(operation);
  const result = await rail.submit(operation, quote, { txHash: "tx_near" });

  assert.equal(result.status, "failed");
  assert.equal(isUnreachable(result), true);
  assert.equal(result.failureReason, UNREACHABLE_REASON);
  // The origin transfer may have happened; the destination swap did not. No
  // destination tx hash is ever claimed.
  assert.equal(result.txHash, undefined);
});

test("poll on an unreachable corridor stays unreachable", async () => {
  const rail = new CrossChainRail({ nearRail: new FakeRail(), treasury: NEAR_USDT });
  const operation = op({ destination: BASE_USDC, corridor: corridor(NEAR_USDT, BASE_USDC) });
  const quote = await rail.quote(operation);
  await rail.submit(operation, quote);
  const polled = await rail.poll(operation.id, quote);
  assert.equal(isUnreachable(polled), true);
});

test("an outbound corridor carries the real keyless price as evidence", async () => {
  let priced = false;
  const rail = new CrossChainRail({
    nearRail: new FakeRail(),
    treasury: NEAR_USDT,
    price: async () => {
      priced = true;
      return {
        correlationId: "corr_1",
        amountIn: "10110954",
        amountOut: "10000000",
        amountOutUsd: "9.9964",
        withdrawFee: "2400",
        timeEstimate: 22,
      };
    },
  });
  const operation = op({ destination: BASE_USDC, corridor: corridor(NEAR_USDT, BASE_USDC) });
  const quote = await rail.quote(operation);
  const result = await rail.submit(operation, quote);

  assert.equal(priced, true, "the corridor was really priced");
  assert.equal(isUnreachable(result), true);
  const evidence = JSON.parse(String(result.evidence)) as { crosschainPrice: Record<string, string> };
  assert.equal(evidence.crosschainPrice["amountOut"], "10000000");
  assert.equal(evidence.crosschainPrice["withdrawFee"], "2400");
});

test("a price failure does not mask the unreachable verdict", async () => {
  const rail = new CrossChainRail({
    nearRail: new FakeRail(),
    treasury: NEAR_USDT,
    price: async () => {
      throw new Error("1Click is down");
    },
  });
  const operation = op({ destination: BASE_USDC, corridor: corridor(NEAR_USDT, BASE_USDC) });
  const quote = await rail.quote(operation);
  const result = await rail.submit(operation, quote);
  assert.equal(isUnreachable(result), true);
});

test("a NEAR corridor is not priced — it is settled for real", async () => {
  let priced = false;
  const rail = new CrossChainRail({
    nearRail: new FakeRail(),
    treasury: NEAR_USDT,
    price: async () => {
      priced = true;
      return { correlationId: "c", amountIn: "1", amountOut: "1" };
    },
  });
  await rail.quote(op());
  assert.equal(priced, false);
});

test("the router is a SettlementRail the money path can drive", () => {
  const rail: SettlementRail = new CrossChainRail({ nearRail: new FakeRail(), treasury: NEAR_USDT });
  assert.equal(rail.name, "crosschain");
  assert.equal(typeof rail.quote, "function");
  assert.equal(typeof rail.submit, "function");
  assert.equal(typeof rail.poll, "function");
});
