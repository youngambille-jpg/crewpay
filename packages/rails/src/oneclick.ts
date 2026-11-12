import type { ChainAsset, Operation } from "@crewpay/domain";
import type { Quote, SettlementRail, SettlementResult } from "./settlement.ts";

const ONE_CLICK_BASE = "https://1click.chaindefuser.com/v0";

/** 1Click uses `nep141:<contract>` for NEAR assets and `nep141:<chain>-<addr>.omft.near` for bridged. */
const ASSET_IDS: Record<string, string> = {
  "near:usdc": "nep141:usdc.near",
  "near:usdt": "nep141:usdt.tether-token.near",
  "near:near": "nep141:wrap.near",
  "base:usdc": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "arbitrum:usdc": "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  "eth:usdc": "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  "solana:usdc": "nep141:sol-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.omft.near",
  "eth:eth": "nep141:eth.omft.near",
  "btc:btc": "nep141:btc.omft.near",
};

export function assetId(ca: ChainAsset): string {
  const id = ASSET_IDS[`${ca.chain}:${ca.asset}`];
  if (!id) throw new Error(`no 1Click asset id for ${ca.chain}:${ca.asset}`);
  return id;
}

export interface OneClickConfig {
  /** JWT or partner API key. Absent means the unauthenticated fee schedule. */
  readonly apiKey?: string;
  /** Basis points Crewpay keeps, collected via `appFees`. */
  readonly appFeeBps?: number;
  readonly appFeeRecipient?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Adapter over the 1Click Swap API. It issues EXACT_OUTPUT quotes so the payee
 * receives exactly the payroll amount, sets `refundTo` so failed swaps are
 * recoverable, and attaches `appFees` to collect Crewpay's take-rate.
 *
 * The transport is injectable so this class can be tested against recorded
 * responses without network access.
 */
export class OneClickRail implements SettlementRail {
  readonly name = "1click";
  private readonly cfg: OneClickConfig;
  private readonly fetch: typeof fetch;

  constructor(cfg: OneClickConfig = {}) {
    this.cfg = cfg;
    this.fetch = cfg.fetchImpl ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  async quote(op: Operation): Promise<Quote> {
    const body = {
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: assetId(op.origin),
      destinationAsset: assetId(op.destination),
      amount: op.amount.amount.toString(),
      recipient: op.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: op.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: op.deadline,
      ...(this.cfg.appFeeBps && this.cfg.appFeeRecipient
        ? { appFees: [{ recipient: this.cfg.appFeeRecipient, fee: this.cfg.appFeeBps }] }
        : {}),
    };
    const res = await this.fetch(`${ONE_CLICK_BASE}/quote`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`1Click quote failed: ${res.status}`);
    const json = (await res.json()) as {
      quote: { depositAddress: string; deadline: string; amountIn: string; amountOut: string };
      quoteRequest?: unknown;
    };
    return {
      quoteId: (json as { correlationId?: string }).correlationId ?? "quote",
      amountIn: BigInt(json.quote.amountIn),
      amountOut: BigInt(json.quote.amountOut),
      feeIn: 0n,
      depositAddress: json.quote.depositAddress,
      deadline: json.quote.deadline,
    };
  }

  async submit(_op: Operation, quote: Quote): Promise<SettlementResult> {
    // ORIGIN_CHAIN deposits are made on-chain by the signer; the rail observes
    // them. With `depositType: INTENTS` this becomes generate-intent/submit-intent.
    return { operationId: _op.id, status: "submitted", quoteId: quote.quoteId };
  }

  async poll(operationId: string): Promise<SettlementResult> {
    const res = await this.fetch(`${ONE_CLICK_BASE}/status?depositAddress=${operationId}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`1Click status failed: ${res.status}`);
    const json = (await res.json()) as { status: string; swapDetails?: { destinationChainTxHashes?: { hash: string }[] } };
    const txHash = json.swapDetails?.destinationChainTxHashes?.[0]?.hash;
    const status: SettlementResult["status"] =
      json.status === "SUCCESS"
        ? "settled"
        : json.status === "FAILED" || json.status === "REFUNDED"
          ? (json.status.toLowerCase() as SettlementResult["status"])
          : "pending";
    return { operationId, status, ...(txHash ? { txHash } : {}) };
  }
}
