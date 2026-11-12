import type { ChainAsset, Operation } from "@crewpay/domain";
import type { AssetRegistry } from "./assets.ts";
import { RailError, type DepositProof, type Quote, type SettlementRail, type SettlementResult, type SettlementStatus } from "./settlement.ts";

/** 1Click chain codes as they appear in the `blockchain` field. */
const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "eth",
  arbitrum: "arb",
  polygon: "pol",
  solana: "sol",
  bitcoin: "btc",
};

/** Map a chain name to 1Click's code (`ethereum` -> `eth`, `solana` -> `sol`). */
export function chainCode(chain: string): string {
  return CHAIN_ALIASES[chain.toLowerCase()] ?? chain.toLowerCase();
}

/** 1Click status vocabulary, from `GetExecutionStatusResponse.status`. */
export type OneClickStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export function mapStatus(status: OneClickStatus | string): SettlementStatus {
  switch (status) {
    case "SUCCESS":
      return "settled";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    case "KNOWN_DEPOSIT_TX":
    case "PENDING_DEPOSIT":
    case "INCOMPLETE_DEPOSIT":
    case "PROCESSING":
      return "pending";
    default:
      return "pending";
  }
}

export interface AppFee {
  /** Account id inside Intents that receives Crewpay's take-rate. */
  readonly recipient: string;
  /** Fee in basis points of `amountIn`. */
  readonly fee: number;
}

export interface OneClickConfig {
  /** Partner API key, sent as the `X-API-Key` header. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Resolves `chain:asset` to a 1Click asset id. */
  readonly registry: AssetRegistry;
  /** Where funds go if the swap cannot complete. */
  readonly refundTo: string;
  /**
   * `ORIGIN_CHAIN` gives a per-chain deposit address the signer funds directly.
   * `INTENTS` gives a single Intents account, useful when treasury already
   * holds funds inside Intents.
   */
  readonly depositType?: "ORIGIN_CHAIN" | "INTENTS";
  /** Crewpay's take-rate, collected by 1Click on our behalf. */
  readonly appFee?: AppFee;
  readonly slippageBps?: number;
  /**
   * Ask 1Click to price the corridor without minting a deposit address. A dry
   * quote is the only 1Click path that needs no partner key, so it is what the
   * live smoke test exercises; a real run leaves this false.
   */
  readonly dry?: boolean;
  /** How far ahead the quote deadline sits, in milliseconds. */
  readonly deadlineMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface QuoteResponseBody {
  readonly correlationId: string;
  readonly signature: string;
  readonly quote: {
    readonly depositAddress: string;
    readonly depositMemo?: string;
    readonly amountIn: string;
    readonly minAmountIn: string;
    readonly amountOut: string;
    readonly minAmountOut: string;
    readonly withdrawFee?: string;
    readonly deadline?: string;
  };
}

interface StatusBody {
  readonly correlationId: string;
  readonly status: string;
  readonly swapDetails?: {
    readonly intentHashes?: readonly string[];
    readonly destinationChainTxHashes?: readonly { hash: string }[];
    readonly refundReason?: string;
  };
}

/**
 * Adapter over the 1Click Swap API, written against the published OpenAPI spec
 * at `https://1click.chaindefuser.com/docs/v0/openapi.yaml`.
 *
 * It issues `EXACT_OUTPUT` quotes so the payee receives exactly the payroll
 * amount, sets `refundTo` so a failed swap is recoverable, and attaches
 * `appFees` to collect Crewpay's take-rate. The transport is injectable so the
 * whole lifecycle can be tested against recorded responses with no network.
 */
export class OneClickRail implements SettlementRail {
  readonly name = "1click";
  private readonly cfg: OneClickConfig;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  /** Polling needs the memo, which is not part of the operation. */
  private readonly memos = new Map<string, string>();

  constructor(cfg: OneClickConfig) {
    this.cfg = cfg;
    this.baseUrl = (cfg.baseUrl ?? "https://1click.chaindefuser.com").replace(/\/$/, "");
    this.fetch = cfg.fetchImpl ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) h["X-API-Key"] = this.cfg.apiKey;
    return h;
  }

  private assetId(ca: ChainAsset): string {
    return this.cfg.registry.require(chainCode(ca.chain), ca.asset).assetId;
  }

  async quote(op: Operation): Promise<Quote> {
    const body = {
      dry: this.cfg.dry ?? false,
      depositType: this.cfg.depositType ?? "ORIGIN_CHAIN",
      swapType: "EXACT_OUTPUT",
      slippageTolerance: this.cfg.slippageBps ?? 100,
      originAsset: this.assetId(op.origin),
      destinationAsset: this.assetId(op.destination),
      amount: op.amount.amount.toString(),
      recipient: op.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: this.cfg.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + (this.cfg.deadlineMs ?? 3_600_000)).toISOString(),
      ...(this.cfg.appFee ? { appFees: [this.cfg.appFee] } : {}),
    };

    const res = await this.fetch(`${this.baseUrl}/v0/quote`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new RailError(this.name, res.status, await errorMessage(res));
    const json = (await res.json()) as QuoteResponseBody;

    const quote: Quote = {
      quoteId: json.correlationId,
      amountOut: BigInt(json.quote.amountOut),
      minAmountOut: BigInt(json.quote.minAmountOut),
      amountIn: BigInt(json.quote.amountIn),
      minAmountIn: BigInt(json.quote.minAmountIn),
      feeIn: BigInt(json.quote.withdrawFee ?? "0"),
      depositAddress: json.quote.depositAddress,
      ...(json.quote.depositMemo ? { depositMemo: json.quote.depositMemo } : {}),
      deadline: json.quote.deadline ?? body.deadline,
      evidence: json.signature,
    };
    if (quote.depositMemo) this.memos.set(op.id, quote.depositMemo);
    return quote;
  }

  /**
   * Tells 1Click the deposit was broadcast so it can verify preemptively. When
   * the signer has not yet broadcast, this is a no-op and the rail reports
   * `submitted`: the deposit address is live and funds may arrive later.
   */
  async submit(op: Operation, quote: Quote, proof?: DepositProof): Promise<SettlementResult> {
    if (!proof) {
      return { operationId: op.id, status: "submitted", quoteId: quote.quoteId };
    }
    const res = await this.fetch(`${this.baseUrl}/v0/deposit/submit`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        txHash: proof.txHash,
        depositAddress: quote.depositAddress,
        ...(proof.nearSenderAccount ? { nearSenderAccount: proof.nearSenderAccount } : {}),
        ...(quote.depositMemo ? { memo: quote.depositMemo } : {}),
      }),
    });
    if (!res.ok) throw new RailError(this.name, res.status, await errorMessage(res));
    const json = (await res.json()) as StatusBody;
    return this.toResult(op.id, quote.quoteId, json);
  }

  async poll(operationId: string, quote?: Quote): Promise<SettlementResult> {
    const params = new URLSearchParams({ depositAddress: quote?.depositAddress ?? operationId });
    const memo = quote?.depositMemo ?? this.memos.get(operationId);
    if (memo) params.set("depositMemo", memo);
    const res = await this.fetch(`${this.baseUrl}/v0/status?${params.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw new RailError(this.name, res.status, await errorMessage(res));
    const json = (await res.json()) as StatusBody;
    return this.toResult(operationId, quote?.quoteId, json);
  }

  private toResult(operationId: string, quoteId: string | undefined, json: StatusBody): SettlementResult {
    const status = mapStatus(json.status);
    const txHash = json.swapDetails?.destinationChainTxHashes?.[0]?.hash;
    const intentHashes = json.swapDetails?.intentHashes ?? [];
    const evidence =
      json.correlationId || txHash
        ? JSON.stringify({ correlationId: json.correlationId, txHash, intentHashes })
        : undefined;
    const failureReason =
      status === "failed" || status === "refunded"
        ? (json.swapDetails?.refundReason ?? json.status)
        : undefined;
    return {
      operationId,
      status,
      ...(quoteId ? { quoteId } : {}),
      ...(txHash ? { txHash } : {}),
      ...(evidence ? { evidence } : {}),
      ...(failureReason ? { failureReason } : {}),
    };
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
