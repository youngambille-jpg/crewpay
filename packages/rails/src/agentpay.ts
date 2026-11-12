import type { AgentProtocol, PayoutReceipt } from "@crewpay/domain";
import { RailError } from "./settlement.ts";

/**
 * One entry of an x402 v2 `accepts[]`. An *unquoted* offer carries an empty
 * `payTo` and `amount` — the amount is only pinned once a quote is minted, so a
 * client that tries to pay from an offer alone is paying a number nobody
 * committed to. `extra.destination` is where settlement lands.
 */
export interface X402Accept {
  /** CAIP-2 origin network, e.g. `eip155:8453` for Base. */
  readonly network: string;
  /** CAIP-19 asset id on that network. */
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface AgentOffers {
  readonly x402Version: number;
  readonly accepts: readonly X402Accept[];
}

/**
 * A live quote. `amountIn` is a **minimum** origin delivery, not a suggestion:
 * Ping grosses up through 1Click and a short deposit comes back
 * `INCOMPLETE_DEPOSIT`. `operationToken` is the idempotency handle — the same
 * token retried after a pending or incomplete settlement completes *that*
 * deposit rather than opening a new one.
 */
export interface AgentQuote {
  readonly operationToken: string;
  readonly depositAddress: string;
  readonly amountIn: bigint;
  readonly network: string;
  readonly asset: string;
  /** ISO timestamp; tokens stay valid for a grace period after it. */
  readonly refundDeadline: string;
}

/**
 * The terminal states a settle call can report. `pending` and `incomplete` are
 * deliberately distinct from `failed`: both mean retry the *same* token, and
 * conflating them with failure is how an in-flight deposit gets abandoned and
 * paid twice.
 */
export type AgentSettleResult =
  | { readonly status: "settled"; readonly receipt: PayoutReceipt }
  | { readonly status: "pending"; readonly reason: string; readonly retryAfterSeconds?: number }
  | { readonly status: "incomplete"; readonly reason: string; readonly depositAddress: string }
  | { readonly status: "failed"; readonly reason: string; readonly retryable: boolean };

export class AgentPayError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(statusCode: number, code: string, message: string) {
    super(`agentpay: ${code}: ${message}`);
    this.name = "AgentPayError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface AgentPayPort {
  readonly name: string;
  /** x402 discovery. No API key: it advertises what the facilitator supports. */
  supported(): Promise<Record<string, unknown>>;
  /** x402 unquoted `accepts[]` for a destination amount. */
  offers(input: { amountOut: bigint; description?: string }): Promise<AgentOffers>;
  /** x402 quote. `refundTo` is required and fails closed if missing (#3370). */
  quote(input: { offer: X402Accept; refundTo: string }): Promise<AgentQuote>;
  /** x402 deposit settlement against a quoted token. Idempotent by token. */
  settle(input: { quote: AgentQuote; txHash: string; depositMemo?: string }): Promise<AgentSettleResult>;
}

/** Base units per whole unit, from a CAIP-19 or 1Click-style decimals hint. */
function parseBaseUnits(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  return 0n;
}

export interface AgentPayConfig {
  /** Facilitator host, e.g. `https://pay.pingpay.io`. */
  readonly baseUrl?: string;
  /** Sent as `X-Api-Key`. Tied to a Ping org whose payee metadata is configured. */
  readonly apiKey: string;
  /** Origin-chain refund address; passed as `refundTo` on the quote payload. */
  readonly refundTo: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Client for Ping's Agent Pay facilitator, x402 #3370 flow.
 *
 * Two things about the direction are easy to get backwards, so they are worth
 * stating. The facilitator settles to the **payee** org that owns the API key,
 * so a facilitator quote describes what *the agent receives* — this client
 * drives that flow on behalf of a payer (CrewPay) paying an agent payee. And
 * `refundTo` is supplied per quote by the payer, never read from the merchant's
 * dashboard: Ping fails closed when it cannot resolve a refund destination,
 * which is the behaviour we want, because a swap that cannot be refunded is
 * money with no way home.
 */
export class AgentPayClient implements AgentPayPort {
  readonly name = "agentpay";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly refundTo: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: AgentPayConfig) {
    this.baseUrl = (cfg.baseUrl ?? "https://pay.pingpay.io").replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.refundTo = cfg.refundTo;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private get x402Base(): string {
    return `${this.baseUrl}/agentpay/x402`;
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown; auth: boolean },
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.auth) headers["x-api-key"] = this.apiKey;
    const res = await this.fetchImpl(`${this.x402Base}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
    }
    return { status: res.status, json };
  }

  async supported(): Promise<Record<string, unknown>> {
    const { status, json } = await this.call("/supported", { method: "GET", auth: false });
    if (status < 200 || status >= 300) {
      throw new AgentPayError(status, String(json["code"] ?? "unsupported"), "discovery failed");
    }
    return json;
  }

  async offers(input: { amountOut: bigint; description?: string }): Promise<AgentOffers> {
    const { status, json } = await this.call("/offers", {
      method: "POST",
      auth: true,
      body: {
        amountOut: input.amountOut.toString(),
        ...(input.description ? { description: input.description } : {}),
      },
    });
    if (status < 200 || status >= 300) {
      throw new AgentPayError(status, String(json["code"] ?? "offers_failed"), "offers failed");
    }
    const accepts = Array.isArray(json["accepts"]) ? (json["accepts"] as X402Accept[]) : [];
    if (accepts.length === 0) {
      throw new AgentPayError(status, "no_accepts", "facilitator returned no origin assets");
    }
    return { x402Version: Number(json["x402Version"] ?? 2), accepts };
  }

  async quote(input: { offer: X402Accept; refundTo?: string }): Promise<AgentQuote> {
    const refundTo = input.refundTo ?? this.refundTo;
    if (!refundTo) {
      // #3370: refundTo is required on the quote payload and there is no
      // dashboard fallback. Refuse locally rather than let Ping fail later,
      // after a deposit address may already be in flight.
      throw new AgentPayError(400, "refund_address_required", "refundTo is required on the quote payload");
    }
    const { status, json } = await this.call("/verify", {
      method: "POST",
      auth: true,
      body: {
        x402Version: 2,
        paymentPayload: { payload: { type: "quote", refundTo } },
        paymentRequirements: input.offer,
      },
    });
    if (status < 200 || status >= 300 || json["isValid"] !== true) {
      // The live verify response reports the cause in `invalidReason` with a
      // human detail in `invalidMessage`. Settle uses `errorReason` instead, and
      // the docs only document the *codes*, not the field, so read all three.
      const code = String(json["invalidReason"] ?? json["code"] ?? json["errorReason"] ?? "quote_failed");
      const detail = typeof json["invalidMessage"] === "string" ? json["invalidMessage"] : "";
      throw new AgentPayError(status, code, detail ? `quote was not minted: ${detail}` : "quote was not minted");
    }
    const extra = (json["extra"] ?? {}) as Record<string, unknown>;
    const depositAddress = extra["depositAddress"];
    const operationToken = extra["operationToken"];
    if (typeof depositAddress !== "string" || typeof operationToken !== "string") {
      throw new AgentPayError(status, "quote_malformed", "quote omitted depositAddress or operationToken");
    }
    return {
      operationToken,
      depositAddress,
      amountIn: parseBaseUnits(extra["amountIn"]),
      network: input.offer.network,
      asset: input.offer.asset,
      refundDeadline: String(extra["refundDeadline"] ?? ""),
    };
  }

  async settle(input: { quote: AgentQuote; txHash: string; depositMemo?: string }): Promise<AgentSettleResult> {
    const { quote } = input;
    const { status, json } = await this.call("/settle", {
      method: "POST",
      auth: true,
      body: {
        x402Version: 2,
        paymentPayload: {
          payload: {
            type: "deposit",
            operationToken: quote.operationToken,
            depositAddress: quote.depositAddress,
            txHash: input.txHash,
            ...(input.depositMemo ? { depositMemo: input.depositMemo } : {}),
          },
        },
        paymentRequirements: { network: quote.network, asset: quote.asset },
      },
    });
    return interpretSettle(status, json, quote);
  }
}

/**
 * Map a settle response onto the four outcomes. The order of the checks matters:
 * `INCOMPLETE_DEPOSIT` arrives with `success: false` and an HTTP 200, so a
 * handler that only looked at `success` would call a top-up-able deposit a
 * failure and abandon it.
 */
export function interpretSettle(
  status: number,
  json: Record<string, unknown>,
  quote: AgentQuote,
): AgentSettleResult {
  const extra = (json["extra"] ?? {}) as Record<string, unknown>;
  const errorReason = typeof json["errorReason"] === "string" ? json["errorReason"] : undefined;
  const extraStatus = typeof extra["status"] === "string" ? extra["status"] : undefined;

  if (json["success"] === true) {
    const transaction = json["transaction"];
    if (typeof transaction !== "string" || transaction.length === 0) {
      // A success with no transaction hash is not evidence. Treat as unknown.
      return { status: "failed", reason: "settled without a transaction hash", retryable: false };
    }
    return {
      status: "settled",
      receipt: {
        operationToken: quote.operationToken,
        depositAddress: quote.depositAddress,
        amountIn: quote.amountIn,
        txHash: transaction,
        network: String(json["network"] ?? quote.network),
        settledAt: new Date().toISOString(),
      },
    };
  }

  if (extraStatus === "INCOMPLETE_DEPOSIT" || errorReason === "INCOMPLETE_DEPOSIT") {
    return {
      status: "incomplete",
      reason: "deposit was short; the challenge is still active",
      depositAddress: quote.depositAddress,
    };
  }

  if (errorReason === "settlement_pending") {
    const retryAfter = json["retryAfter"];
    return {
      status: "pending",
      reason: "settlement still processing",
      ...(typeof retryAfter === "number" ? { retryAfterSeconds: retryAfter } : {}),
    };
  }

  // 503/504 are transient; 402 is a terminal failure or refund. Distinguishing
  // them keeps a retry loop from hammering a terminal error, or from giving up
  // on a hiccup.
  const retryable = status === 503 || status === 504 || status === 429;
  return {
    status: "failed",
    reason: errorReason ?? String(json["code"] ?? `http ${status}`),
    retryable,
  };
}

/** The protocol a task uses, for logging and the receipt trail. */
export function protocolOf(protocol: AgentProtocol): string {
  return protocol === "x402" ? "x402-exact-near-intents" : "mpp-charge";
}
