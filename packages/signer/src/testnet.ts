import type { Operation } from "@crewpay/domain";
import { mockAsset, type Quote } from "@crewpay/rails";
import { OutLayerSigner } from "./outlayer.ts";
import type {
  CustodyPolicy,
  FundingOutcome,
  FundingPlan,
  FundingRequestState,
  Signer,
  SignerWallet,
} from "./signer.ts";

export interface TestnetSignerConfig {
  /** `wk_` API key for a testnet custody wallet. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Funds testnet payouts from an OutLayer testnet wallet. Canonical assets map
 * to mock contracts (near:usdt -> usdt.fakes.testnet) and everything moves
 * on-chain, since testnet has no Intents solvers. Funding mechanics are the
 * real OutLayerSigner's — this only changes what token a plan names.
 */
export class TestnetSigner implements Signer {
  readonly name = "testnet";
  private readonly inner: OutLayerSigner;

  constructor(cfg: TestnetSignerConfig) {
    this.inner = new OutLayerSigner({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl ?? "https://testnet-api.outlayer.ai",
      ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
      ...(cfg.pollIntervalMs !== undefined ? { pollIntervalMs: cfg.pollIntervalMs } : {}),
      ...(cfg.maxPolls !== undefined ? { maxPolls: cfg.maxPolls } : {}),
      ...(cfg.sleep ? { sleep: cfg.sleep } : {}),
    });
  }

  get wallet(): SignerWallet {
    return this.inner.wallet;
  }

  async loadWallet(): Promise<SignerWallet> {
    return this.inner.loadWallet();
  }

  get custody(): CustodyPolicy {
    return this.inner.custody;
  }

  async reconcile(requestId: string): Promise<FundingRequestState> {
    return this.inner.reconcile(requestId);
  }

  plan(operation: Operation, quote: Quote): FundingPlan {
    const mock = mockAsset(operation.origin.chain, operation.origin.asset);
    const memo = quote.depositMemo;
    return {
      route: "onchain",
      chain: "near",
      token: mock.contract,
      amount: quote.amountIn.toString(),
      ...(memo ? { memo } : {}),
    };
  }

  fund(operation: Operation, quote: Quote, plan: FundingPlan): Promise<FundingOutcome> {
    return this.inner.fund(operation, quote, plan);
  }
}
