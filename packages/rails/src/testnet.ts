import type { Operation } from "@crewpay/domain";
import type { DepositProof, Quote, SettlementRail, SettlementResult } from "./settlement.ts";

/** A mock asset on NEAR testnet standing in for a canonical asset. */
export interface MockAsset {
  /** The testnet NEP-141 contract. */
  readonly contract: string;
  readonly decimals: number;
  readonly symbol: string;
}

/**
 * Canonical (chain, asset) -> testnet mock contract. Verified live via
 * ft_metadata on testnet; the fakes are 6dp like their mainnet selves.
 * Testnet-only: mainnet execution must never resolve through this table.
 */
export const MOCK_ASSETS: Readonly<Record<string, MockAsset>> = {
  "near:usdt": { contract: "usdt.fakes.testnet", decimals: 6, symbol: "USDT.e" },
  "near:usdc": { contract: "usdc.fakes.testnet", decimals: 6, symbol: "USDC.e" },
};

export class UnknownMockError extends Error {
  constructor(chain: string, asset: string) {
    super(`no testnet mock known for ${chain}:${asset}`);
    this.name = "UnknownMockError";
  }
}

export function mockAsset(chain: string, asset: string): MockAsset {
  const found = MOCK_ASSETS[`${chain.toLowerCase()}:${asset.toLowerCase()}`];
  if (!found) throw new UnknownMockError(chain, asset);
  return found;
}

export interface TestnetRailConfig {
  /** NEAR testnet RPC endpoint. */
  readonly rpcUrl?: string;
  /** Account that broadcasts the payout (the custody wallet's testnet account). */
  readonly senderAccount: string;
  readonly fetchImpl?: typeof fetch;
  /** Delay before each status read; testnet needs ~1 block to finalize. */
  readonly pollDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Settlement on NEAR testnet with mock assets. There is no swap: the quote's
 * deposit address IS the recipient, so the signer's funding transfer pays the
 * user directly and this rail only verifies the broadcast on-chain.
 */
export class TestnetRail implements SettlementRail {
  readonly name = "testnet";
  private readonly rpcUrl: string;
  private readonly sender: string;
  private readonly fetch: typeof fetch;
  private readonly pollDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** operationId -> broadcast tx, recorded at submit for poll to verify. */
  private readonly txs = new Map<string, string>();

  constructor(cfg: TestnetRailConfig) {
    // rpc.testnet.near.org is deprecated and throttles to 429; FastNEAR answers.
    this.rpcUrl = cfg.rpcUrl ?? "https://rpc.testnet.fastnear.com";
    this.sender = cfg.senderAccount;
    this.fetch = cfg.fetchImpl ?? globalThis.fetch;
    this.pollDelayMs = cfg.pollDelayMs ?? 1200;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 1:1 mock amounts, payable straight to the recipient. */
  async quote(op: Operation): Promise<Quote> {
    mockAsset(op.destination.chain, op.destination.asset);
    return {
      quoteId: `testnet_${op.id}`,
      amountOut: op.amount.amount,
      minAmountOut: op.amount.amount,
      amountIn: op.amount.amount,
      minAmountIn: op.amount.amount,
      feeIn: 0n,
      depositAddress: op.recipient,
      deadline: op.deadline,
      evidence: "testnet-direct: no swap, custody pays the recipient",
    };
  }

  async submit(op: Operation, quote: Quote, proof?: DepositProof): Promise<SettlementResult> {
    if (!proof) {
      return {
        operationId: op.id,
        status: "failed",
        quoteId: quote.quoteId,
        failureReason: "testnet rail pays direct: submit needs the deposit proof",
      };
    }
    this.txs.set(op.id, proof.txHash);
    return { operationId: op.id, status: "submitted", quoteId: quote.quoteId, txHash: proof.txHash };
  }

  /** Verify the broadcast against testnet RPC. A read failure stays pending. */
  async poll(operationId: string, quote?: Quote): Promise<SettlementResult> {
    const txHash = this.txs.get(operationId);
    const quoteId = quote?.quoteId;
    if (!txHash) {
      return { operationId, status: "pending", ...(quoteId ? { quoteId } : {}) };
    }
    await this.sleep(this.pollDelayMs);
    let body: unknown;
    try {
      const res = await this.fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "testnet-poll",
          method: "EXPERIMENTAL_tx_status",
          params: [txHash, this.sender],
        }),
      });
      body = (await res.json()) as unknown;
    } catch {
      return { operationId, status: "pending", ...(quoteId ? { quoteId } : {}) };
    }
    const status = (body as { result?: { status?: unknown } }).result?.status;
    if (typeof status === "object" && status !== null) {
      if ("SuccessValue" in status || "SuccessReceiptId" in status) {
        return {
          operationId,
          status: "settled",
          ...(quoteId ? { quoteId } : {}),
          txHash,
          evidence: JSON.stringify({ txHash, network: "near:testnet" }),
        };
      }
      if ("Failure" in status) {
        const failure = (status as { Failure: unknown }).Failure;
        return {
          operationId,
          status: "failed",
          ...(quoteId ? { quoteId } : {}),
          txHash,
          failureReason: JSON.stringify(failure).slice(0, 200),
        };
      }
    }
    // Unknown tx (not yet visible) or an unreadable row: not an answer.
    return { operationId, status: "pending", ...(quoteId ? { quoteId } : {}), txHash };
  }
}
