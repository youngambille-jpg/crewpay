import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChainAsset, PingCheckoutStatus, UsdCents } from "@crewpay/domain";
import { RailError } from "./settlement.ts";

/**
 * Ping's API uses two different keys for two different jobs, and swapping them
 * is the mistake this client exists to prevent:
 *
 * - `x-publishable-key` (`pk_`) on the checkout and payment routes. These run
 *   in the customer's browser, so the key is public by design.
 * - `x-api-key` on the Agent Pay facilitator, which the agent calls server-side.
 *
 * A publishable key in the agent's config is not a leak. A *secret* key sent to
 * a browser would be, which is why there is no way to reach the facilitator
 * with one here.
 */
export interface PingPayConfig {
  /** `pk_` key for checkout and payment reads. Safe to expose to a browser. */
  readonly publishableKey: string;
  /** Signing secret (`whsec_`) used to verify inbound webhooks. */
  readonly webhookSecret?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Tolerated clock skew on a webhook timestamp, in seconds. */
  readonly toleranceSeconds?: number;
  /** Injectable clock so replay-window tests are deterministic. */
  readonly now?: () => number;
}

export interface CreateCheckoutInput {
  readonly amount: UsdCents;
  /** What the payer pays in, and where Ping routes it. */
  readonly asset: ChainAsset;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  /** Merchant-scoped customer key, stored on the session and the payment. */
  readonly customerReference?: string;
  readonly metadata?: Record<string, string>;
  /** Redirect (default) or popup. */
  readonly displayMode?: "redirect" | "popup";
}

export interface CheckoutSession {
  readonly sessionId: string;
  readonly status: PingCheckoutStatus;
  readonly paymentId?: string;
  readonly expiresAt?: string;
  /** Opaque; use exactly as returned and never construct it. */
  readonly sessionUrl?: string;
  readonly customerReference?: string;
}

/**
 * The checkout + webhook surface the API depends on. `PingPayClient` is the
 * production implementation and `FakePingPay` the test one; typing against the
 * interface keeps the API free of any HTTP detail.
 */
export interface PingPayPort {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  getCheckout(sessionId: string): Promise<CheckoutSession>;
  verifyWebhook(rawBody: string, headers: PingWebhookHeaders): Record<string, unknown>;
}

export class WebhookVerificationError extends Error {
  readonly reason: "missing_signature" | "stale_timestamp" | "bad_signature";

  constructor(reason: "missing_signature" | "stale_timestamp" | "bad_signature") {
    super(`pingpay webhook rejected: ${reason}`);
    this.name = "WebhookVerificationError";
    this.reason = reason;
  }
}

export interface PingWebhookHeaders {
  readonly signature?: string;
  readonly timestamp?: string;
}

/**
 * Verify a Ping webhook signature and decode the event.
 *
 * Three checks, and the second is the one people skip:
 *
 * 1. The signature is an HMAC-SHA256 over `${timestamp}.${rawBody}`, hex.
 * 2. The timestamp is inside the tolerance window. Without this a captured
 *    request verifies forever, so a `payment.success` replayed a year later
 *    still passes the signature check.
 * 3. The comparison is timing-safe. A byte-by-byte `===` leaks how much of a
 *    guessed signature is correct.
 *
 * The body must be the *raw* bytes: re-serialising parsed JSON changes key
 * order and whitespace, and the signature covers what was sent.
 */
export function verifyPingWebhook(
  rawBody: string,
  headers: PingWebhookHeaders,
  secret: string,
  opts: { readonly toleranceSeconds?: number; readonly now?: () => number } = {},
): Record<string, unknown> {
  const { signature, timestamp } = headers;
  if (!signature || !timestamp) throw new WebhookVerificationError("missing_signature");

  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? (() => Date.now());
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) throw new WebhookVerificationError("stale_timestamp");
  // Ping sends seconds; tolerate the window in both directions so a fast clock
  // ahead of ours does not reject a genuine delivery.
  if (Math.abs(now() / 1000 - sentAt) > tolerance) {
    throw new WebhookVerificationError("stale_timestamp");
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookVerificationError("bad_signature");
  }

  return JSON.parse(rawBody) as Record<string, unknown>;
}

/**
 * Thin client for Ping's API. It owns the two auth headers and the webhook
 * secret, so no caller has to remember which key goes where.
 */
export class PingPayClient implements PingPayPort {
  readonly name = "pingpay";
  private readonly publishableKey: string;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly toleranceSeconds: number;
  private readonly now: () => number;

  constructor(cfg: PingPayConfig) {
    this.publishableKey = cfg.publishableKey;
    this.webhookSecret = cfg.webhookSecret;
    this.baseUrl = (cfg.baseUrl ?? "https://pay.pingpay.io/api").replace(/\/$/, "");
    this.fetch = cfg.fetchImpl ?? fetch;
    this.toleranceSeconds = cfg.toleranceSeconds ?? 300;
    this.now = cfg.now ?? (() => Date.now());
  }

  /** Create a hosted checkout session. No payment happens here. */
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const body: Record<string, unknown> = {
      amount: String(input.amount * 10_000),
      asset: { chain: input.asset.chain.toUpperCase(), symbol: input.asset.asset.toUpperCase() },
      ...(input.successUrl ? { successUrl: input.successUrl } : {}),
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
      ...(input.customerReference ? { customerReference: input.customerReference } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.displayMode ? { displayMode: input.displayMode } : {}),
    };

    const res = await this.request("POST", "/checkout/sessions", body);
    const session = res["session"] as Record<string, unknown> | undefined;
    if (!session) throw new RailError(this.name, 502, "checkout response carried no session");
    return {
      sessionId: String(session["sessionId"]),
      status: String(session["status"]) as PingCheckoutStatus,
      ...(session["paymentId"] ? { paymentId: String(session["paymentId"]) } : {}),
      ...(session["expiresAt"] ? { expiresAt: String(session["expiresAt"]) } : {}),
      ...(typeof res["sessionUrl"] === "string" ? { sessionUrl: res["sessionUrl"] } : {}),
      ...(session["customerReference"] ? { customerReference: String(session["customerReference"]) } : {}),
    };
  }

  /**
   * Read the authoritative session state. A webhook says what happened; this
   * says what is true now, and is what a reconciliation job should believe.
   */
  async getCheckout(sessionId: string): Promise<CheckoutSession> {
    const res = await this.request("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const session = res["session"] as Record<string, unknown> | undefined;
    if (!session) throw new RailError(this.name, 502, "checkout response carried no session");
    return {
      sessionId: String(session["sessionId"]),
      status: String(session["status"]) as PingCheckoutStatus,
      ...(session["paymentId"] ? { paymentId: String(session["paymentId"]) } : {}),
      ...(session["expiresAt"] ? { expiresAt: String(session["expiresAt"]) } : {}),
    };
  }

  /** Read a payment. Final only at SUCCESS or FAILED. */
  async getPayment(paymentId: string): Promise<{ paymentId: string; status: string }> {
    const res = await this.request("GET", `/payments/${encodeURIComponent(paymentId)}`);
    const payment = res["payment"] as Record<string, unknown> | undefined;
    if (!payment) throw new RailError(this.name, 502, "payment response carried no payment");
    return { paymentId: String(payment["paymentId"]), status: String(payment["status"]) };
  }

  /** Verify and decode an inbound webhook. Requires a configured secret. */
  verifyWebhook(rawBody: string, headers: PingWebhookHeaders): Record<string, unknown> {
    if (!this.webhookSecret) {
      throw new RailError(this.name, 500, "no webhook secret configured");
    }
    return verifyPingWebhook(rawBody, headers, this.webhookSecret, {
      toleranceSeconds: this.toleranceSeconds,
      now: this.now,
    });
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      // Checkout and payment routes take the publishable key, not the secret.
      "x-publishable-key": this.publishableKey,
      accept: "application/json",
    };
    if (body) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new RailError(this.name, 0, `request failed: ${String(cause)}`);
    }

    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { message: text };
      }
    }
    if (!res.ok) {
      const code = String(parsed["code"] ?? parsed["error"] ?? `http_${res.status}`);
      const message = String(parsed["message"] ?? res.statusText ?? code);
      throw new RailError(this.name, res.status, `${code}: ${message}`);
    }
    return parsed;
  }
}
