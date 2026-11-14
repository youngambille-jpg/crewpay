/**
 * Live access to the three external services CrewPay depends on.
 *
 * CrewPay runs on NEAR testnet, so a dashboard that only ever showed fake data
 * would prove nothing. This module reaches the *real* services on the paths
 * that are free and unauthenticated, so the operator can see live
 * infrastructure while no money is at risk.
 *
 * What is real here, and what is not — verified against the live APIs:
 *
 *   - OutLayer custody: `POST /register` mints a real wallet with a real
 *     `wk_` key and a real NEAR account. Address, balance, policy reads and
 *     `encrypt-policy` all work on an unfunded wallet.
 *   - Intents withdraw `dry-run` runs the full policy + balance + storage check
 *     inside the TEE and returns a `policy_check`, with no signing and no
 *     broadcast. This is the strongest no-funds proof available.
 *   - 1Click prices corridors with `dry: true` and needs no partner key.
 *   - Ping advertises capability on `/agentpay/x402/supported`.
 *
 * What is NOT real, and is never implied: the final broadcast. NEAR Intents is
 * mainnet-only (testnet returns `service_unavailable`, "no testnet solvers"),
 * and 1Click and Ping have no testnet at all — so there is no testnet
 * settlement path anywhere in this stack. A real payout needs a funded mainnet
 * wallet, and the UI says so rather than pretending.
 *
 * The `wk_` key and `PING_API_KEY` are read from the environment and held in
 * memory only. They are never logged, never serialised to a client, and never
 * written to disk.
 */

import type { ChainAsset } from "@crewpay/domain";
import {
  AssetRegistry,
  OneClickRail,
  type DepositQuote,
  type PriceSource,
  type QuotePreview,
} from "@crewpay/rails";

const ONECLICK_URL = process.env["ONECLICK_BASE_URL"] ?? "https://1click.chaindefuser.com";
const PING_URL = process.env["PING_BASE_URL"] ?? "https://pay.pingpay.io";
const OUTLAYER_URL = process.env["OUTLAYER_BASE_URL"] ?? "https://api.outlayer.ai";
const TIMEOUT_MS = Number(process.env["LIVE_TIMEOUT_MS"] ?? 12_000);

/**
 * The origin chains a cross-chain deposit can be priced from, and the neutral
 * refund address 1Click requires per chain. These are placeholders, not the
 * operator's own address: the card is a simulation, so nothing is ever sent and
 * nothing can be refunded — the address exists only to satisfy the quote API's
 * validation. `refundTo` must be a well-formed address on the origin chain.
 */
export interface FundingChain {
  readonly chain: string;
  /** Asset symbol as 1Click lists it on that chain. */
  readonly asset: string;
  readonly symbol: string;
  readonly label: string;
  /** A valid, neutral address on this chain; the quote API rejects a blank one. */
  readonly refundTo: string;
}

export const FUNDING_CHAINS: readonly FundingChain[] = [
  {
    chain: "base",
    asset: "usdc",
    symbol: "USDC",
    label: "Base",
    refundTo: "0x0000000000000000000000000000000000000001",
  },
  {
    chain: "eth",
    asset: "usdc",
    symbol: "USDC",
    label: "Ethereum",
    refundTo: "0x0000000000000000000000000000000000000001",
  },
  {
    chain: "arb",
    asset: "usdc",
    symbol: "USDC",
    label: "Arbitrum",
    refundTo: "0x0000000000000000000000000000000000000001",
  },
  {
    chain: "sol",
    asset: "usdc",
    symbol: "USDC",
    label: "Solana",
    refundTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  },
];

export type ServiceStatus = "ok" | "down" | "skipped";

export interface ServiceHealth {
  readonly name: string;
  readonly status: ServiceStatus;
  readonly detail: string;
  readonly ms: number;
}

export interface LiveHealth {
  readonly checkedAt: string;
  readonly services: readonly ServiceHealth[];
  /** True only when every service answered. */
  readonly allUp: boolean;
}

/** A provisioned custody wallet. The `apiKey` never leaves the server. */
export interface LiveWallet {
  readonly walletId: string;
  readonly nearAccountId: string;
  readonly createdAt: string;
}

/** The TEE's verdict on a withdraw, as `dry-run` returns it. */
export interface PolicyCheck {
  readonly withinLimits: boolean;
  readonly addressAllowed: boolean;
}

export interface DryRunResult {
  readonly wouldSucceed: boolean;
  readonly reason?: string;
  readonly message?: string;
  readonly policyCheck?: PolicyCheck;
}

export interface CompiledPolicy {
  readonly walletId: string;
  /** Base64 blob the TEE will enforce. Safe to show; useless without the key. */
  readonly ciphertext: string;
}

/** A signature the wallet owner can submit to store the policy on-chain. */
export interface SignedPolicy {
  readonly signature: string;
  readonly publicKey: string;
  /** The version `store_wallet_policy` must exceed by one. */
  readonly version: number;
  readonly policyHash: string;
  readonly validUntil: number;
}

/**
 * Whether the TEE actually enforces a policy.
 *
 * This distinction matters and is easy to overclaim. `compiled` means we have a
 * real encrypted blob and a real signature; `stored` means the owner has
 * submitted it on-chain and the TEE will now enforce it. Storing needs a funded
 * account, so a freshly connected wallet sits at `compiled` — and until it is
 * `stored`, a dry-run reporting `within_limits: true` proves only that *no*
 * policy refused it, not that ours allowed it.
 */
export type PolicyState = "none" | "compiled" | "stored";

interface RegisterResponse {
  readonly wallet_id: string;
  readonly api_key: string;
  readonly near_account_id: string;
  readonly handoff_url?: string;
}

/** A fetch that refuses to hang: a dead service must fail fast, not stall. */
function timedFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })) as typeof fetch;
}

/**
 * Live service access, plus the wallet this process has been given.
 *
 * The wallet is held in memory because provisioning happens at runtime: the
 * operator clicks Connect, and only then does a key exist. Restarting the
 * process forgets it, which is honest — a persisted wallet belongs behind real
 * storage, not an in-memory field.
 */
export class LiveServices {
  private readonly fetchImpl: typeof fetch;
  private wallet?: { info: LiveWallet; apiKey: string; handoffUrl?: string };
  private cachedHealth?: { at: number; health: LiveHealth };
  /** Set once a policy has been compiled, so we know it is at least compiled. */
  private compiledPolicy?: CompiledPolicy;
  /** The live 1Click token list, fetched once on first use. */
  private assetRegistry?: AssetRegistry;

  constructor(cfg: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = cfg.fetchImpl ?? timedFetch();
  }

  /** The wallet provisioned by a Connect, if any. */
  get connected(): LiveWallet | undefined {
    return this.wallet?.info;
  }

  /**
   * Ping each service on its cheapest unauthenticated path. Cached briefly so
   * a page load does not hammer three third parties.
   */
  async health(maxAgeMs = 30_000): Promise<LiveHealth> {
    if (this.cachedHealth && Date.now() - this.cachedHealth.at < maxAgeMs) {
      return this.cachedHealth.health;
    }

    const [oneclick, outlayer, ping] = await Promise.all([
      this.probe("1Click", async () => {
        const res = await this.fetchImpl(`${ONECLICK_URL}/v0/tokens`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // `/v0/tokens` answers with a bare array, not an object.
        const body = (await res.json()) as { symbol?: string; price?: number }[];
        if (!Array.isArray(body)) throw new Error("unexpected payload shape");
        // A live price is stronger evidence than a count: it proves the feed is
        // current rather than merely reachable.
        const near = body.find((t) => t.symbol === "wNEAR");
        const price = near?.price ? ` · wNEAR $${near.price}` : "";
        return `${body.length} assets${price}`;
      }),
      this.probe("OutLayer", async () => {
        const res = await this.fetchImpl(`${OUTLAYER_URL}/public/connectors`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return "custody API reachable";
      }),
      this.probe("Ping", async () => {
        const res = await this.fetchImpl(`${PING_URL}/agentpay/x402/supported`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { kinds?: unknown[] };
        return `x402 v2 · ${body.kinds?.length ?? 0} kinds`;
      }),
    ]);

    const services = [oneclick, outlayer, ping];
    const health: LiveHealth = {
      checkedAt: new Date().toISOString(),
      services,
      allUp: services.every((s) => s.status === "ok"),
    };
    this.cachedHealth = { at: Date.now(), health };
    return health;
  }

  /** Time one probe and turn any failure into a reportable status. */
  private async probe(name: string, run: () => Promise<string>): Promise<ServiceHealth> {
    const started = Date.now();
    try {
      const detail = await run();
      return { name, status: "ok", detail, ms: Date.now() - started };
    } catch (err) {
      return {
        name,
        status: "down",
        detail: err instanceof Error ? err.message : "unreachable",
        ms: Date.now() - started,
      };
    }
  }

  /**
   * Provision a real custody wallet. `POST /register` with an empty body mints
   * one and returns a `wk_` key shown exactly once — so it is captured here and
   * never fetched again.
   *
   * Reconnecting replaces the wallet in memory rather than piling up keys, so
   * the process never holds more than one.
   */
  async connect(): Promise<LiveWallet> {
    const res = await this.fetchImpl(`${OUTLAYER_URL}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      throw new Error(`OutLayer /register failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as RegisterResponse;
    if (!body.api_key || !body.near_account_id) {
      throw new Error("OutLayer /register returned no api_key or near_account_id");
    }
    const info: LiveWallet = {
      walletId: body.wallet_id,
      nearAccountId: body.near_account_id,
      createdAt: new Date().toISOString(),
    };
    // The handoff URL embeds the `wk_` key in its query string. It is kept here
    // and reached through a server-side redirect, never rendered into a page —
    // this API is served publicly, so anything in the DOM is readable by anyone.
    this.wallet = {
      info,
      apiKey: body.api_key,
      ...(body.handoff_url ? { handoffUrl: body.handoff_url } : {}),
    };
    return info;
  }

  /** The provider's dashboard link for the connected wallet, if it gave one. */
  get handoffUrl(): string | undefined {
    return this.wallet?.handoffUrl;
  }

  /**
   * Compile the org's rules into the encrypted blob the TEE enforces. This is
   * the real policy the wallet would run under — not a local copy of our own
   * limits. It needs no funds, so it works on a freshly connected wallet.
   */
  async compilePolicy(rules: OutLayerRules): Promise<CompiledPolicy> {
    const wallet = this.requireWallet();
    const res = await this.fetchImpl(`${OUTLAYER_URL}/wallet/v1/encrypt-policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${wallet.apiKey}`,
      },
      body: JSON.stringify({ wallet_id: wallet.info.walletId, rules }),
    });
    if (!res.ok) {
      throw new Error(`encrypt-policy failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { encrypted_base64?: string };
    if (!body.encrypted_base64) throw new Error("encrypt-policy returned no ciphertext");
    this.compiledPolicy = { walletId: wallet.info.walletId, ciphertext: body.encrypted_base64 };
    return this.compiledPolicy;
  }

  /**
   * Sign the compiled policy so its owner can store it on-chain. This is the
   * last step we can take for free: `store_wallet_policy` itself is a NEAR
   * transaction and needs a funded account.
   */
  async signPolicy(ciphertext: string): Promise<SignedPolicy> {
    const wallet = this.requireWallet();
    const res = await this.fetchImpl(`${OUTLAYER_URL}/wallet/v1/sign-policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${wallet.apiKey}`,
      },
      body: JSON.stringify({
        encrypted_data: ciphertext,
        caller: wallet.info.nearAccountId,
      }),
    });
    if (!res.ok) {
      throw new Error(`sign-policy failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      signature: String(body["signature_hex"] ?? ""),
      publicKey: String(body["public_key_hex"] ?? ""),
      version: Number(body["version"] ?? 0),
      policyHash: String(body["policy_hash"] ?? ""),
      validUntil: Number(body["valid_until"] ?? 0),
    };
  }

  /**
   * How far the policy has actually got. Reads the TEE's own view rather than
   * trusting our local record, because "we compiled it" and "the enclave
   * enforces it" are different claims.
   */
  async policyState(): Promise<{ state: PolicyState; version: number; locked: boolean }> {
    const wallet = this.requireWallet();
    const res = await this.fetchImpl(`${OUTLAYER_URL}/wallet/v1/policy`, {
      headers: { authorization: `Bearer ${wallet.apiKey}` },
    });
    if (!res.ok) throw new Error(`policy read failed: HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    // `policy: "none"` means no policy is stored, so every operation is allowed.
    const stored = body["policy"] === "stored";
    return {
      state: stored ? "stored" : "none",
      version: Number(body["version"] ?? 0),
      locked: body["locked"] === true,
    };
  }

  /**
   * Ask the TEE whether a withdraw would pass policy and balance. No signing,
   * no broadcast — the strongest proof of the policy path that costs nothing.
   */
  async dryRunWithdraw(req: {
    chain: string;
    amount: string;
    to: string;
    token?: string;
  }): Promise<DryRunResult> {
    const wallet = this.requireWallet();
    const res = await this.fetchImpl(`${OUTLAYER_URL}/wallet/v1/intents/withdraw/dry-run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${wallet.apiKey}`,
      },
      body: JSON.stringify(req),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      // A 503 here is the expected answer on testnet, where Intents has no
      // solvers. Surface it as a reason rather than throwing, so the UI can
      // explain the limitation instead of showing a broken screen.
      return {
        wouldSucceed: false,
        reason: String(body["error"] ?? `HTTP ${res.status}`),
        message: String(body["message"] ?? ""),
      };
    }
    const pc = body["policy_check"] as Record<string, unknown> | undefined;
    return {
      wouldSucceed: body["would_succeed"] === true,
      ...(body["reason"] ? { reason: String(body["reason"]) } : {}),
      ...(body["message"] ? { message: String(body["message"]) } : {}),
      ...(pc
        ? {
            policyCheck: {
              withinLimits: pc["within_limits"] === true,
              addressAllowed: pc["address_allowed"] === true,
            },
          }
        : {}),
    };
  }

  /** The wallet's intents balance for a token, as the TEE reports it. */
  async intentsBalance(token: string): Promise<string> {
    const wallet = this.requireWallet();
    const res = await this.fetchImpl(
      `${OUTLAYER_URL}/wallet/v1/balance?chain=near&source=intents&token=${encodeURIComponent(token)}`,
      { headers: { authorization: `Bearer ${wallet.apiKey}` } },
    );
    if (!res.ok) throw new Error(`balance read failed: HTTP ${res.status}`);
    const body = (await res.json()) as { balance?: string };
    return body.balance ?? "0";
  }

  /**
   * Price a cross-chain deposit into the treasury with a real 1Click dry quote.
   *
   * This needs no wallet and no partner key, so it is the one Intents path that
   * is genuinely live. It returns a price and a fee, never a deposit address:
   * the simulated funding card shows the operator what the corridor would cost,
   * and stops there. A real deposit address would imply funds can move, and on
   * this stack they cannot — Intents and 1Click have no testnet.
   */
  async fundingQuote(input: {
    chain: string;
    amountUsdCents: number;
    recipient: string;
  }): Promise<{ preview: QuotePreview; origin: ChainAsset; destination: ChainAsset; chain: FundingChain }> {
    const chain = FUNDING_CHAINS.find((c) => c.chain === input.chain.toLowerCase());
    if (!chain) throw new Error(`unsupported funding chain: ${input.chain}`);
    const registry = await this.registry();
    const origin: ChainAsset = { chain: chain.chain, asset: chain.asset };
    // The treasury receives mainnet USDT — the real asset the testnet mock
    // mirrors. Amount is EXACT_OUTPUT in the origin asset's base units.
    const destination: ChainAsset = { chain: "near", asset: "usdt" };
    const amount = registry.toBaseUnits(input.amountUsdCents / 100, chain.chain, chain.symbol);
    const rail = new OneClickRail({ registry, refundTo: chain.refundTo, fetchImpl: this.fetchImpl });
    const preview = await rail.preview({
      origin,
      destination,
      amount,
      recipient: input.recipient,
      refundTo: chain.refundTo,
    });
    return { preview, origin, destination, chain };
  }

  /** The live 1Click token list, fetched once and reused. */
  private async registry(): Promise<AssetRegistry> {
    if (!this.assetRegistry) {
      this.assetRegistry = await AssetRegistry.fromApi(this.fetchImpl, ONECLICK_URL);
    }
    return this.assetRegistry;
  }

  /**
   * Price a real customer payment into a NEAR recipient, from any supported
   * chain, and mint a deposit address the customer sends to. This is the same
   * 1Click engine as `fundingQuote`, but not dry: the returned address is live
   * and settles to `recipient`. The customer's own transfer is the only step we
   * do not perform — everything up to it, and the settlement, is real.
   */
  async paymentQuote(input: {
    originChain: string;
    amountUsdCents: number;
    recipient: string;
  }): Promise<{ quote: DepositQuote; origin: ChainAsset; destination: ChainAsset; chain: FundingChain }> {
    const chain = FUNDING_CHAINS.find((c) => c.chain === input.originChain.toLowerCase());
    if (!chain) throw new Error(`unsupported payment chain: ${input.originChain}`);
    const registry = await this.registry();
    const origin: ChainAsset = { chain: chain.chain, asset: chain.asset };
    const destination: ChainAsset = { chain: "near", asset: "usdt" };
    const amount = registry.toBaseUnits(input.amountUsdCents / 100, chain.chain, chain.symbol);
    const rail = new OneClickRail({ registry, refundTo: chain.refundTo, fetchImpl: this.fetchImpl });
    const quote = await rail.depositQuote({
      origin,
      destination,
      amount,
      recipient: input.recipient,
      refundTo: chain.refundTo,
    });
    return { quote, origin, destination, chain };
  }

  /** Read a customer payment's status by the deposit address 1Click minted. */
  async paymentStatus(input: {
    depositAddress: string;
    depositMemo?: string;
  }): Promise<{ status: string; raw: string; txHashes: readonly string[]; refundReason?: string }> {
    const registry = await this.registry();
    const rail = new OneClickRail({ registry, refundTo: "0x0000000000000000000000000000000000000001", fetchImpl: this.fetchImpl });
    return rail.statusByDeposit(input);
  }

  /**
   * A keyless price for a cross-chain corridor, for the router's honest
   * "unreachable, and here is what it would have cost" answer. Uses the live
   * `dry: true` quote, so it needs no partner key and moves nothing.
   */
  crossChainPrice(): PriceSource {
    return async (input) => {
      const registry = await this.registry();
      const rail = new OneClickRail({ registry, refundTo: "0x0000000000000000000000000000000000000001", fetchImpl: this.fetchImpl });
      const preview = await rail.preview(input);
      return {
        correlationId: preview.correlationId,
        amountIn: preview.amountIn,
        amountOut: preview.amountOut,
        ...(preview.amountInUsd ? { amountInUsd: preview.amountInUsd } : {}),
        ...(preview.amountOutUsd ? { amountOutUsd: preview.amountOutUsd } : {}),
        ...(preview.withdrawFee ? { withdrawFee: preview.withdrawFee } : {}),
        ...(typeof preview.timeEstimate === "number" ? { timeEstimate: preview.timeEstimate } : {}),
      };
    };
  }

  /** The policy the TEE actually enforces — read, never written, by us. */
  async effectivePolicy(): Promise<Record<string, unknown>> {
    const wallet = this.requireWallet();
    const res = await this.fetchImpl(`${OUTLAYER_URL}/wallet/v1/policy`, {
      headers: { authorization: `Bearer ${wallet.apiKey}` },
    });
    if (!res.ok) throw new Error(`policy read failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private requireWallet(): { info: LiveWallet; apiKey: string } {
    if (!this.wallet) {
      throw new Error("no custody wallet connected; POST /v1/connect first");
    }
    return this.wallet;
  }
}

/** The rule shape OutLayer's `encrypt-policy` accepts. */
export interface OutLayerRules {
  readonly transaction_types: readonly string[];
  readonly allowed_tokens: readonly string[];
  readonly limits: { readonly per_transaction: Record<string, string> };
}

/** Translate CrewPay's rule shape into OutLayer's policy rules. */
export function toOutLayerRules(rules: {
  maxPerTransactionCents?: number;
  allowedAssets?: readonly string[];
  allowedPayeeKinds?: readonly string[];
}): OutLayerRules {
  // OutLayer's `per_transaction` is a map of token id -> amount in the token's
  // smallest unit, and `"*"` matches every token. wNEAR has 24 decimals, and
  // our caps are USD cents, so the cap is expressed in cents at that scale.
  const perTx = BigInt(rules.maxPerTransactionCents ?? 500_000) * 10n ** 22n;
  return {
    transaction_types: ["withdraw", "cross_chain_withdraw"],
    allowed_tokens: ["*"],
    limits: { per_transaction: { "*": perTx.toString() } },
  };
}
