import { AgentPayError } from "./agentpay.ts";

/**
 * The MPP charge endpoint is a *payee* surface: you point it at your own
 * facilitator host and it quotes, verifies the credential, and settles to your
 * org's recipient. It is here so a CrewPay org that *sells* to agents can bill
 * them over the same rails it pays them on, rather than because the payout path
 * needs it.
 *
 * The unauthenticated 402 challenge and the 202 pending case are the two
 * responses worth modelling precisely: a 402 is the normal "you have not paid"
 * answer, not an error, and a 202 means retry the *same* credential — following
 * a Location header instead would mint a fresh quote and abandon a deposit that
 * is already in flight, which is why Ping deliberately sends none.
 */
export interface MppChargeConfig {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

export interface MppChargeInput {
  /** Destination base units, as an integer string. */
  readonly amountOut: bigint;
  /** Stable identity for what is being charged, e.g. `invoice/2026-001`. */
  readonly challengeIdentity?: string;
  readonly description?: string;
  readonly externalId?: string;
  /** Origin-chain refund for this charge; required for confidential Intents. */
  readonly refundAddress?: string;
}

export type MppChargeResult =
  | { readonly status: "unpaid"; readonly challenge: Record<string, unknown> }
  | { readonly status: "paid"; readonly receipt?: string }
  | { readonly status: "pending"; readonly retryAfterSeconds?: number }
  | { readonly status: "failed"; readonly code: string; readonly retryable: boolean };

export class MppChargeClient {
  readonly name = "mpp";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: MppChargeConfig) {
    this.baseUrl = (cfg.baseUrl ?? "https://pay.pingpay.io").replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /**
   * Post a charge. With no credential this returns the 402 challenge; with one
   * it either settles (200) or reports a non-terminal state to retry (202).
   */
  async charge(input: MppChargeInput, credential?: string): Promise<MppChargeResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
    };
    if (credential) headers["authorization"] = credential;
    const res = await this.fetchImpl(`${this.baseUrl}/agentpay/mpp/charge`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        amountOut: input.amountOut.toString(),
        ...(input.challengeIdentity ? { challengeIdentity: input.challengeIdentity } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.externalId ? { externalId: input.externalId } : {}),
        ...(input.refundAddress ? { refundAddress: input.refundAddress } : {}),
      }),
    });

    const retryAfter = res.headers.get("retry-after");
    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
    }
    const code = String(json["code"] ?? "");

    if (res.status === 402 && !credential) {
      return { status: "unpaid", challenge: json };
    }
    if (res.status === 202 || code === "settlement_pending") {
      return {
        status: "pending",
        ...(retryAfter ? { retryAfterSeconds: Number(retryAfter) } : {}),
      };
    }
    if (res.status === 200 && (json["status"] === "paid" || json["status"] === undefined)) {
      const receipt = res.headers.get("payment-receipt") ?? undefined;
      return { status: "paid", ...(receipt ? { receipt } : {}) };
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AgentPayError(res.status, code || "unauthorized", "charge rejected");
    }
    const retryable = res.status === 503 || res.status === 504;
    return { status: "failed", code: code || `http_${res.status}`, retryable };
  }
}
