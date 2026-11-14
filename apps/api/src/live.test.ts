import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { FakeRail, FakePingPay, FakeAgentPay } from "@crewpay/rails";
import { createApi } from "./server.ts";
import { TEST_TOKEN, testAuth } from "./auth.ts";
import { toOutLayerRules, type LiveServices } from "./live.ts";

const KEY = "wk_testkeymustnotleak0123456789";
const HANDOFF = `https://app.outlayer.ai/wallet?key=${KEY}`;

/**
 * A stand-in for the real LiveServices, so the HTTP layer can be tested without
 * a network. It mirrors the real surface, including the `handoffUrl` getter
 * whose value must never reach a client.
 */
function stubLive(): LiveServices {
  const wallet = {
    walletId: "wal_1",
    nearAccountId: "a".repeat(64),
    createdAt: new Date().toISOString(),
  };
  return {
    connected: wallet,
    handoffUrl: HANDOFF,
    health: async () => ({
      checkedAt: new Date().toISOString(),
      services: [
        { name: "1Click", status: "ok" as const, detail: "231 assets", ms: 12 },
      ],
      allUp: true,
    }),
    connect: async () => wallet,
    compilePolicy: async () => ({ walletId: "wal_1", ciphertext: "Y2lwaGVy" }),
    signPolicy: async () => ({
      signature: "ab".repeat(64),
      publicKey: "cd".repeat(32),
      version: 1,
      policyHash: "ef".repeat(32),
      validUntil: 1_800_000_000,
    }),
    policyState: async () => ({ state: "none" as const, version: 0, locked: false }),
    dryRunWithdraw: async () => ({
      wouldSucceed: false,
      reason: "insufficient_balance",
      message: "have 0, need 1",
      policyCheck: { withinLimits: true, addressAllowed: true },
    }),
    intentsBalance: async () => "0",
    effectivePolicy: async () => ({ wallet_id: "wal_1", policy: "none" }),
  } as unknown as LiveServices;
}

async function start(live?: LiveServices) {
  const { server } = createApi({
    auth: testAuth(),
    rail: new FakeRail(),
    pingpay: new FakePingPay({ webhookSecret: "whsec_dev" }),
    agentpay: new FakeAgentPay(),
    ...(live ? { live } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text() };
  };
  /** A GET that must not follow the redirect, so Location can be inspected. */
  const redirect = async (path: string) => {
    const res = await fetch(url + path, {
      redirect: "manual",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    return { status: res.status, location: res.headers.get("location") };
  };
  return { server, call, redirect };
}

test("health reports no services when live services are not configured", async () => {
  const { server, call } = await start();
  try {
    const { status, text } = await call("/v1/live/health", "GET");
    assert.equal(status, 200);
    const body = JSON.parse(text);
    assert.equal(body.allUp, false);
    assert.deepEqual(body.services, []);
  } finally {
    server.close();
  }
});

test("health passes through the live service report", async () => {
  const { server, call } = await start(stubLive());
  try {
    const { status, text } = await call("/v1/live/health", "GET");
    assert.equal(status, 200);
    const body = JSON.parse(text);
    assert.equal(body.allUp, true);
    assert.equal(body.services[0].name, "1Click");
  } finally {
    server.close();
  }
});

test("connect returns a wallet but never the api key or handoff url", async () => {
  const { server, call } = await start(stubLive());
  try {
    const { status, text } = await call("/v1/connect", "POST", {});
    assert.equal(status, 201);
    const body = JSON.parse(text);
    assert.equal(body.connected, true);
    assert.equal(body.wallet.nearAccountId, "a".repeat(64));
    // The whole point: this API is served publicly, so neither the `wk_` key nor
    // a URL containing it may appear anywhere in a response body.
    assert.ok(!text.includes(KEY), "response must not contain the wallet key");
    assert.ok(!text.includes("wk_"), "response must not contain a wk_ token");
    assert.ok(!text.includes("handoff_url"), "response must not carry the handoff url");
  } finally {
    server.close();
  }
});

test("connect state advertises only that a handoff exists", async () => {
  const { server, call } = await start(stubLive());
  try {
    const { status, text } = await call("/v1/connect", "GET");
    assert.equal(status, 200);
    const body = JSON.parse(text);
    assert.equal(body.hasHandoff, true);
    assert.equal(body.wallet.handoffUrl, undefined);
    assert.ok(!text.includes(KEY), "state must not contain the wallet key");
  } finally {
    server.close();
  }
});

test("handoff redirects server-side to the provider, key and all", async () => {
  const { server, redirect } = await start(stubLive());
  try {
    const { status, location } = await redirect("/v1/connect/handoff");
    assert.equal(status, 302);
    // The key must still reach the provider — it is the operator's own wallet —
    // but only via a redirect the browser follows, never in a page body.
    assert.equal(location, HANDOFF);
  } finally {
    server.close();
  }
});

test("handoff 404s when nothing is connected", async () => {
  const { server, call } = await start();
  try {
    const { status } = await call("/v1/connect/handoff", "GET");
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test("publish compiles and signs, and reports the policy is not yet stored", async () => {
  const { server, call } = await start(stubLive());
  try {
    const { status, text } = await call("/v1/policies/publish", "POST", {
      orgId: "org_1",
      rules: { maxPerTransactionCents: 500_000 },
    });
    assert.equal(status, 201);
    const body = JSON.parse(text);
    assert.equal(body.published, true);
    assert.equal(body.ciphertextBytes, "Y2lwaGVy".length);
    assert.equal(body.signed.version, 1);
    // Compiled is not stored; saying otherwise would overclaim enforcement.
    assert.equal(body.policyState, "compiled");
  } finally {
    server.close();
  }
});

test("publish refuses without a connected wallet", async () => {
  const { server, call } = await start();
  try {
    const { status } = await call("/v1/policies/publish", "POST", { orgId: "org_1" });
    assert.equal(status, 400);
  } finally {
    server.close();
  }
});

test("dry-run surfaces the enclave's policy check and reason", async () => {
  const { server, call } = await start(stubLive());
  try {
    const { status, text } = await call("/v1/live/dry-run", "POST", {
      chain: "near",
      amount: "1",
      to: "crewpay.near",
    });
    assert.equal(status, 200);
    const body = JSON.parse(text);
    assert.equal(body.wouldSucceed, false);
    assert.equal(body.reason, "insufficient_balance");
    assert.equal(body.policyCheck.withinLimits, true);
    assert.equal(body.policyCheck.addressAllowed, true);
  } finally {
    server.close();
  }
});

test("custody reports the enclave's own policy state", async () => {
  const { server, call } = await start(stubLive());
  try {
    const { status, text } = await call("/v1/live/custody", "GET");
    assert.equal(status, 200);
    const body = JSON.parse(text);
    assert.equal(body.connected, true);
    // "none" is the honest answer for a fresh wallet, and the UI depends on it.
    assert.equal(body.policyState, "none");
    assert.equal(body.intentsBalance, "0");
  } finally {
    server.close();
  }
});

test("toOutLayerRules expresses the per-transaction cap in the token's base unit", () => {
  const rules = toOutLayerRules({ maxPerTransactionCents: 500_000 });
  // $5,000 at wNEAR's 24 decimals is 500000 cents * 10^22.
  assert.equal(rules.limits.per_transaction["*"], (500_000n * 10n ** 22n).toString());
  assert.deepEqual(rules.transaction_types, ["withdraw", "cross_chain_withdraw"]);
});

test("toOutLayerRules defaults to a $5,000 cap when none is given", () => {
  const rules = toOutLayerRules({});
  assert.equal(rules.limits.per_transaction["*"], (500_000n * 10n ** 22n).toString());
});
