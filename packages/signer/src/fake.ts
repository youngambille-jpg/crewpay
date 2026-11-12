import type { Operation } from "@crewpay/domain";
import type { Quote } from "@crewpay/rails";
import type { FundingOutcome, FundingPlan, Signer, SignerWallet } from "./signer.ts";

export interface FakeSignerOptions {
  /** Operations that fund successfully but report no tx identifier. */
  readonly unprovableOperationIds?: readonly string[];
  /** Operations that fail in a way that is safe to retry. */
  readonly retryableFailureOperationIds?: readonly string[];
  /** Operations that fail after possibly moving funds (not safe to retry). */
  readonly unsafeFailureOperationIds?: readonly string[];
  /** Operations whose funding state is unknown and need a human. */
  readonly needsReviewOperationIds?: readonly string[];
  /** Operations that never settle within the poll budget. */
  readonly stuckOperationIds?: readonly string[];
  readonly wallet?: SignerWallet;
}

/**
 * Deterministic signer for tests and local runs. It produces the same
 * `FundingOutcome` variants as `OutLayerSigner` so the orchestrator's handling
 * of the hard cases — unknown fund state, retry safety — is exercised offline.
 */
export class FakeSigner implements Signer {
  readonly name = "fake";
  readonly wallet: SignerWallet;
  private readonly cfg: FakeSignerOptions;

  constructor(cfg: FakeSignerOptions = {}) {
    this.cfg = cfg;
    this.wallet = cfg.wallet ?? { walletId: "wallet_fake", nearAccountId: "wallet_fake.near" };
  }

  plan(operation: Operation, quote: Quote): FundingPlan {
    const chain = operation.origin.chain;
    const memo = quote.depositMemo;
    if (chain !== "near") {
      return {
        route: "intents",
        chain,
        token: `nep141:${operation.origin.asset}`,
        amount: quote.amountIn.toString(),
        ...(memo ? { memo } : {}),
      };
    }
    return {
      route: "onchain",
      chain: "near",
      token: operation.origin.asset,
      amount: quote.amountIn.toString(),
      ...(memo ? { memo } : {}),
    };
  }

  async fund(operation: Operation, _quote: Quote, plan: FundingPlan): Promise<FundingOutcome> {
    const id = operation.id;
    if (this.cfg.needsReviewOperationIds?.includes(id)) {
      return { kind: "needs_review", reason: "injected unknown state", requestId: `req_${id}` };
    }
    if (this.cfg.stuckOperationIds?.includes(id)) {
      return { kind: "pending", reason: "injected stall", requestId: `req_${id}` };
    }
    if (this.cfg.retryableFailureOperationIds?.includes(id)) {
      return { kind: "failed", reason: "injected transient failure", safeToRetry: true };
    }
    if (this.cfg.unsafeFailureOperationIds?.includes(id)) {
      return { kind: "failed", reason: "injected bridge failure", safeToRetry: false };
    }
    if (this.cfg.unprovableOperationIds?.includes(id)) {
      return { kind: "needs_review", reason: "funding succeeded but no tx identifier was returned" };
    }
    return { kind: "deposited", proof: { txHash: this.proofFor(plan, id) } };
  }

  /** On-chain funding yields a NEAR tx hash; an Intents withdraw yields the delivery tx. */
  private proofFor(plan: FundingPlan, id: string): string {
    return plan.route === "intents" ? `0xdeposit_${id}` : `tx_${id}`;
  }
}
