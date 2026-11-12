import type { Operation } from "@crewpay/domain";
import { chainCode, type DepositProof, type Quote } from "@crewpay/rails";
import { idempotencyKey } from "./idempotency.ts";
import {
  OutLayerClient,
  TransportError,
  isPollableStatus,
  isTerminalStatus,
  type OutLayerRequestRow,
} from "./outlayer-client.ts";
import { SignerError, type FundingOutcome, type FundingPlan, type Signer, type SignerWallet } from "./signer.ts";

export interface OutLayerSignerConfig {
  /** `wk_` API key for a custody wallet. The only secret the signer holds. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Prefer a gasless Intents withdraw when the origin asset lives in the
   * wallet's Intents balance. When false, always fund on-chain.
   */
  readonly preferIntents?: boolean;
  /** How long to wait for a funding request to reach a terminal state. */
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Funds deposits from an OutLayer custody wallet whose keys live in a TEE.
 * Crewpay holds only the `wk_` API key, so a compromise of this process cannot
 * extract a key or bypass the wallet's on-chain policy: the enclave evaluates
 * the policy before it signs.
 *
 * Two funding routes exist and they are not interchangeable:
 * - `intents` — a gasless withdraw that delivers the asset to the rail's
 *   deposit address. Works with no gas token and from any origin chain.
 * - `onchain` — a native NEAR transfer or an NEP-141 `ft_transfer` from the
 *   wallet's own account. Needs NEAR for gas and the recipient to have storage.
 */
export class OutLayerSigner implements Signer {
  readonly name = "outlayer";
  private readonly client: OutLayerClient;
  private readonly preferIntents: boolean;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private cachedWallet?: SignerWallet;

  constructor(cfg: OutLayerSignerConfig) {
    this.client = new OutLayerClient({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
    });
    this.preferIntents = cfg.preferIntents ?? true;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 2_000;
    this.maxPolls = cfg.maxPolls ?? 15;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolved once and reused; the address is stable for a wallet. */
  get wallet(): SignerWallet {
    if (!this.cachedWallet) {
      throw new Error("wallet not loaded; call loadWallet() before use");
    }
    return this.cachedWallet;
  }

  async loadWallet(): Promise<SignerWallet> {
    const { address } = await this.client.address();
    this.cachedWallet = { walletId: address, nearAccountId: address };
    return this.cachedWallet;
  }

  plan(operation: Operation, quote: Quote): FundingPlan {
    // A memo pins the deposit to this quote on chains that use one.
    const memo = quote.depositMemo;
    const chain = chainCode(operation.origin.chain);
    const amount = quote.amountIn.toString();

    if (this.preferIntents && chain !== "near") {
      return {
        route: "intents",
        chain,
        token: this.intentsToken(operation),
        amount,
        ...(memo ? { memo } : {}),
      };
    }

    // On-chain: NEAR uses a native transfer; any NEP-141 token uses ft_transfer.
    if (chain === "near" && operation.origin.asset.toLowerCase() === "near") {
      return { route: "onchain", chain: "near", token: "near", amount, ...(memo ? { memo } : {}) };
    }
    return {
      route: "onchain",
      chain: "near",
      token: this.contractId(operation),
      amount,
      ...(memo ? { memo } : {}),
    };
  }

  async fund(operation: Operation, quote: Quote, plan: FundingPlan): Promise<FundingOutcome> {
    const key = idempotencyKey(operation.id, "fund", quote.quoteId);
    let row: OutLayerRequestRow;
    try {
      row = await this.dispatch(plan, quote, key);
    } catch (err) {
      // The request never reached the service: nothing moved, resend is safe.
      if (err instanceof TransportError) {
        return { kind: "failed", reason: err.message, safeToRetry: true };
      }
      if (err instanceof SignerError) {
        // Auth, policy and shape errors are answered synchronously and moved
        // nothing, so they are safe to retry once corrected.
        return { kind: "failed", reason: `${err.code}: ${err.message}`, safeToRetry: true };
      }
      throw err;
    }
    const settled = isTerminalStatus(String(row.status)) ? row : await this.awaitRequest(row);
    return this.interpret(operation, plan, settled);
  }

  private dispatch(plan: FundingPlan, quote: Quote, key: string): Promise<OutLayerRequestRow> {
    const memo = plan.memo ?? quote.depositMemo;
    if (plan.route === "intents") {
      return this.client.intentsWithdraw(quote.depositAddress, plan.amount, plan.token, plan.chain, key);
    }
    if (plan.token === "near") {
      return this.client.transferNear(quote.depositAddress, plan.amount, key);
    }
    return this.client.ftTransfer(plan.token, quote.depositAddress, plan.amount, key, memo);
  }

  private async awaitRequest(row: OutLayerRequestRow): Promise<OutLayerRequestRow> {
    let current = row;
    for (let i = 0; i < this.maxPolls; i += 1) {
      if (!isPollableStatus(String(current.status))) return current;
      const id = this.requestId(current);
      if (!id) return current;
      await this.sleep(this.pollIntervalMs);
      try {
        current = await this.client.getRequest(id);
      } catch (err) {
        // A read failure says nothing about the money, so surface it as
        // unresolved rather than as a failure the caller might retry.
        if (err instanceof TransportError) {
          return { request_id: id, status: "needs_review" };
        }
        throw err;
      }
    }
    return { ...current, status: "needs_review" };
  }

  private interpret(
    operation: Operation,
    plan: FundingPlan,
    row: OutLayerRequestRow,
  ): FundingOutcome {
    const status = String(row.status);
    const id = this.requestId(row);
    const reason = this.reason(row);

    if (status === "success") {
      const proof = this.proof(plan, row);
      if (!proof) {
        // Success without an identifier means the deposit was made but we
        // cannot prove it to the rail; a human should confirm before resending.
        return { kind: "needs_review", reason: "funding succeeded but no tx identifier was returned", ...(id ? { requestId: id } : {}) };
      }
      return { kind: "deposited", proof };
    }

    if (status === "failed") {
      const result = (row.result ?? {}) as Record<string, unknown>;
      const neverExecuted = result["never_executed"] === true || result["never_submitted"] === true;
      return {
        kind: "failed",
        reason: reason ?? "funding failed",
        safeToRetry: neverExecuted,
      };
    }

    if (status === "rejected") {
      return { kind: "failed", reason: reason ?? "approvers rejected the funding request", safeToRetry: true };
    }

    if (status === "refunded") {
      return { kind: "failed", reason: reason ?? "funding was refunded", safeToRetry: true };
    }

    if (status === "pending_approval" || status === "approved") {
      return { kind: "pending", reason: "awaiting multisig approval", ...(id ? { requestId: id } : {}) };
    }

    if (status === "processing" || status === "pending_deposit") {
      return { kind: "pending", reason: "funding still settling", ...(id ? { requestId: id } : {}) };
    }

    // needs_review, or anything unrecognised: the fund state is unknown.
    return {
      kind: "needs_review",
      reason: reason ?? `fund state unknown (status ${status})`,
      ...(id ? { requestId: id } : {}),
    };
  }

  /**
   * The proof handed to the rail. On the on-chain route that is the NEAR tx
   * hash. On the Intents route there is no origin tx: the real, linkable
   * transaction is `destination_tx_hash`, the delivery on the origin chain.
   * Neither `transfer_intent_hash` nor `intent_hash` is a chain transaction.
   */
  private proof(plan: FundingPlan, row: OutLayerRequestRow): DepositProof | undefined {
    const result = (row.result ?? {}) as Record<string, unknown>;
    if (plan.route === "intents") {
      const tx = result["destination_tx_hash"];
      return typeof tx === "string" && tx ? { txHash: tx } : undefined;
    }
    const tx = result["tx_hash"];
    return typeof tx === "string" && tx ? { txHash: tx } : undefined;
  }

  private reason(row: OutLayerRequestRow): string | undefined {
    const result = (row.result ?? {}) as Record<string, unknown>;
    const r = result["reason"];
    return typeof r === "string" ? r : undefined;
  }

  private requestId(row: OutLayerRequestRow): string | undefined {
    const id = row.request_id;
    return typeof id === "string" && id ? id : undefined;
  }

  /** Asset id as Intents names it (a `nep141:`/`nep245:` id on intents.near). */
  private intentsToken(operation: Operation): string {
    const { asset } = operation.origin;
    return asset.includes(":") ? asset : `nep141:${asset}`;
  }

  /** Plain NEAR contract id, for the on-chain `ft_transfer` call. */
  private contractId(operation: Operation): string {
    const { asset } = operation.origin;
    return asset.startsWith("nep141:") ? asset.slice("nep141:".length) : asset;
  }
}
