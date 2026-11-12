import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PingPayClient, WebhookVerificationError } from "./pingpay.ts";
import { FakePingPay } from "./pingpay-fake.ts";

const SECRET = "whsec_test_secret";
const NOW = 1_760_000_000_000; // fixed clock, seconds = 1760000000

function signed(body: unknown, atSeconds = NOW / 1000) {
  const raw = JSON.stringify(body);
  const timestamp = String(atSeconds);
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${raw}`).digest("hex");
  return { raw, headers: { signature, timestamp } };
}

function client(overrides: Partial<ConstructorParameters<typeof PingPayClient>[0]> = {}) {
  return new PingPayClient({
    publishableKey: "pk_test_123",
    webhookSecret: SECRET,
    now: () => NOW,
    ...overrides,
  });
}

test("a well-formed webhook verifies and decodes", () => {
  const { raw, headers } = signed({ id: "evt_1", type: "payment.success", resourceId: "pay_1" });
  const event = client().verifyWebhook(raw, headers);
  assert.equal(event["id"], "evt_1");
  assert.equal(event["type"], "payment.success");
});

test("a tampered body fails the signature even with a valid header", () => {
  const { headers } = signed({ id: "evt_1", type: "payment.success", resourceId: "pay_1" });
  const tampered = JSON.stringify({ id: "evt_1", type: "payment.success", resourceId: "pay_ATTACKER" });
  assert.throws(() => client().verifyWebhook(tampered, headers), WebhookVerificationError);
});

test("a signature over a different timestamp is rejected", () => {
  const { raw } = signed({ id: "evt_1" });
  // Same body, but the attacker moved the timestamp forward to look fresh.
  const forged = createHmac("sha256", SECRET).update(`${NOW / 1000 + 10}.${raw}`).digest("hex");
  assert.throws(
    () => client().verifyWebhook(raw, { signature: forged, timestamp: String(NOW / 1000) }),
    WebhookVerificationError,
  );
});

test("a replayed webhook outside the tolerance window is rejected", () => {
  // Signed correctly, but a day old. Without the window this verifies forever.
  const { raw, headers } = signed({ id: "evt_1" }, NOW / 1000 - 86_400);
  assert.throws(
    () => client().verifyWebhook(raw, headers),
    (err: unknown) => err instanceof WebhookVerificationError && err.reason === "stale_timestamp",
  );
});

test("a webhook from the future is rejected too", () => {
  const { raw, headers } = signed({ id: "evt_1" }, NOW / 1000 + 86_400);
  assert.throws(
    () => client().verifyWebhook(raw, headers),
    (err: unknown) => err instanceof WebhookVerificationError && err.reason === "stale_timestamp",
  );
});

test("missing signature or timestamp is rejected, not treated as empty", () => {
  const { raw } = signed({ id: "evt_1" });
  assert.throws(() => client().verifyWebhook(raw, {}), WebhookVerificationError);
  assert.throws(() => client().verifyWebhook(raw, { signature: "abc" }), WebhookVerificationError);
});

test("a non-numeric timestamp is rejected rather than parsed as zero", () => {
  const { raw } = signed({ id: "evt_1" });
  assert.throws(
    () => client().verifyWebhook(raw, { signature: "abc", timestamp: "not-a-number" }),
    (err: unknown) => err instanceof WebhookVerificationError && err.reason === "stale_timestamp",
  );
});

test("verifying without a configured secret is a configuration error, not a pass", () => {
  const { raw, headers } = signed({ id: "evt_1" });
  const noSecret = new PingPayClient({ publishableKey: "pk_test_123", now: () => NOW });
  assert.throws(() => noSecret.verifyWebhook(raw, headers), /no webhook secret configured/);
});

test("createCheckout sends the publishable key and never the secret", async () => {
  let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    seen = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(
      JSON.stringify({
        session: { sessionId: "cs_1", status: "CREATED" },
        sessionUrl: "https://checkout.pingpay.io/session/cs_1",
      }),
      { status: 200 },
    );
  };
  const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch });
  const session = await c.createCheckout({
    amount: 250_000,
    asset: { chain: "near", asset: "usdc" },
    customerReference: "acme",
  });

  assert.equal(session.sessionId, "cs_1");
  assert.equal(session.sessionUrl, "https://checkout.pingpay.io/session/cs_1");
  assert.equal(seen!.url, "https://pay.pingpay.io/api/checkout/sessions");
  assert.equal(seen!.headers["x-publishable-key"], "pk_test_123");
  assert.equal(seen!.headers["x-api-key"], undefined);
  // 250000 cents = 2500.00 USDC -> 2500 * 10^6 base units.
  assert.equal(seen!.body["amount"], "2500000000");
  assert.deepEqual(seen!.body["asset"], { chain: "NEAR", symbol: "USDC" });
  assert.equal(seen!.body["customerReference"], "acme");
});

test("a non-2xx response raises a RailError carrying Ping's code", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ code: "INVALID_PUBLISHABLE_KEY", message: "Publishable key is invalid." }), {
      status: 401,
    });
  const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch });
  await assert.rejects(
    () => c.createCheckout({ amount: 100, asset: { chain: "near", asset: "usdc" } }),
    /INVALID_PUBLISHABLE_KEY/,
  );
});

test("getCheckout reads the session and defaults a null paymentId away", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ session: { sessionId: "cs_9", status: "PENDING", paymentId: null } }), {
      status: 200,
    });
  const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch });
  const session = await c.getCheckout("cs_9");
  assert.equal(session.status, "PENDING");
  assert.equal(session.paymentId, undefined);
});

test("the fake signs events that the real verifier accepts", () => {
  const fake = new FakePingPay({ webhookSecret: SECRET, now: () => NOW });
  const { body, headers } = fake.signEvent({ id: "evt_2", type: "checkout.session.completed" });
  const event = client().verifyWebhook(body, headers);
  assert.equal(event["id"], "evt_2");
});
