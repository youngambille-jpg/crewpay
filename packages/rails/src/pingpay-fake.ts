import { createHmac } from "node:crypto";
import type { PingCheckoutStatus } from "@crewpay/domain";
import type { CheckoutSession, CreateCheckoutInput, PingPayPort, PingWebhookHeaders } from "./pingpay.ts";
import { verifyPingWebhook } from "./pingpay.ts";

export interface FakePingPayOptions {
  readonly webhookSecret?: string;
  /** Session status the fake reports on read-back. Default `COMPLETED`. */
  readonly sessionStatus?: PingCheckoutStatus;
  /** Force the read-back to report a different status than the webhook claimed. */
  readonly readBackStatus?: PingCheckoutStatus;
  readonly now?: () => number;
}

/**
 * An in-process stand-in for Ping's API.
 *
 * It reproduces the one behaviour that matters for correctness testing: the
 * webhook and the session read-back are independent sources, so a test can make
 * them disagree and prove the handler trusts the read-back over the webhook.
 * It also signs events exactly as Ping does, so signature verification runs for
 * real rather than being stubbed out.
 */
export class FakePingPay implements PingPayPort {
  readonly name = "pingpay";
  private readonly secret: string;
  private readonly now: () => number;
  private sessions = new Map<string, CheckoutSession>();
  private counter = 0;
  sessionStatus: PingCheckoutStatus;
  readBackStatus: PingCheckoutStatus | undefined;
  /** Set to make `getCheckout` throw, to exercise the failure path. */
  readBackFails = false;
  /** Set to make `createCheckout` throw, to exercise the error-status mapping. */
  createCheckoutError: Error | undefined;

  constructor(opts: FakePingPayOptions = {}) {
    this.secret = opts.webhookSecret ?? "whsec_test_secret";
    this.sessionStatus = opts.sessionStatus ?? "COMPLETED";
    this.readBackStatus = opts.readBackStatus;
    this.now = opts.now ?? (() => Date.now());
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    if (this.createCheckoutError) throw this.createCheckoutError;
    const sessionId = `cs_${++this.counter}`;
    const session: CheckoutSession = {
      sessionId,
      status: "CREATED",
      ...(input.customerReference ? { customerReference: input.customerReference } : {}),
      sessionUrl: `https://checkout.pingpay.io/session/${sessionId}`,
      expiresAt: new Date(this.now() + 900_000).toISOString(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async getCheckout(sessionId: string): Promise<CheckoutSession> {
    if (this.readBackFails) throw new Error("pingpay: session read failed");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`pingpay: unknown session ${sessionId}`);
    return { ...session, status: this.readBackStatus ?? this.sessionStatus };
  }

  async getPayment(paymentId: string): Promise<{ paymentId: string; status: string }> {
    return { paymentId, status: "SUCCESS" };
  }

  /** Mark a session's read-back state, as Ping would after the payer acts. */
  setSessionStatus(sessionId: string, status: PingCheckoutStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, status });
  }

  verifyWebhook(rawBody: string, headers: PingWebhookHeaders): Record<string, unknown> {
    return verifyPingWebhook(rawBody, headers, this.secret, { now: this.now });
  }

  /** Produce a signed body + headers exactly as Ping would send them. */
  signEvent(body: Record<string, unknown>, opts: { at?: number } = {}): {
    body: string;
    headers: PingWebhookHeaders;
  } {
    const raw = JSON.stringify(body);
    const timestamp = String(opts.at ?? Math.floor(this.now() / 1000));
    const signature = createHmac("sha256", this.secret)
      .update(`${timestamp}.${raw}`)
      .digest("hex");
    return { body: raw, headers: { signature, timestamp } };
  }
}
