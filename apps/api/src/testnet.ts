/**
 * Testnet payout services: a server-held OutLayer testnet wallet plus the
 * adapters that pay mock USDT through the real loop.
 *
 * Why this exists: the dashboard cannot hold keys or sign, so every testnet
 * step the UI offers — register, status, prepare, pay — runs here. The `wk_`
 * key lives in this process only (like LiveServices' wallet) and is never
 * returned, logged, or written anywhere; clients see the account id and the
 * on-chain state derived from it.
 *
 * What is real: the wallet, the gas and token balances, storage deposits, the
 * open mint, and the payout broadcast are all live testnet. What is mock: the
 * USDT itself (usdt.fakes.testnet) and the 1:1 testnet quote — there is no
 * swap on testnet. Runs booked here carry `sourceRef: "testnet"` so mock
 * settlements are never mistaken for mainnet money in the books.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CrossChainRail, TestnetRail, type PriceSource, type SettlementRail } from "@crewpay/rails";
import { OutLayerClient, TestnetSigner, isTerminalStatus } from "@crewpay/signer";

export const TESTNET_USDT = "usdt.fakes.testnet";
const MIN_GAS_YOCTO = 50_000_000_000_000_000_000_000n;
const STORAGE_YOCTO = "1250000000000000000000";
const MINT_BASE = "10000000";
const TIMEOUT_MS = 12_000;

export interface TestnetStatus {
  readonly connected: boolean;
  readonly account?: string;
  readonly gasYocto?: string;
  readonly usdtBase?: string;
}

export interface PrepareStep {
  readonly step: "gas" | "storage_self" | "mint" | "storage_recipient";
  readonly status: "ok" | "skipped" | "failed";
  readonly detail?: string;
}

export interface PrepareResult {
  readonly steps: readonly PrepareStep[];
  readonly ready: boolean;
}

export interface MintResult {
  readonly steps: readonly PrepareStep[];
  readonly ready: boolean;
  /** The wallet's mock-USDT balance after the mint, in base units. */
  readonly balanceBase: string;
}

export interface TestnetServicesConfig {
  readonly outlayerUrl?: string;
  readonly nearRpcUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Prices a corridor the treasury cannot reach (a keyless 1Click dry quote).
   * Supplied by `LiveServices`; when absent, an outbound corridor still fails by
   * name, just without the price attached.
   */
  readonly priceOutbound?: PriceSource;
  /**
   * Where to persist the held wallet's `wk_` key so a restart reuses the same
   * funded account instead of minting a fresh one. Omit to keep it in memory
   * only (tests). The file is written 0600 and is never logged or served.
   */
  readonly statePath?: string;
  /**
   * A wallet `wk_` key from the environment (a secret store on hosted
   * platforms, where the state file does not survive a deploy). Tried when no
   * state file holds a working key: a valid key is held and persisted, an
   * invalid one is ignored and a fresh wallet is minted.
   */
  readonly restoreApiKey?: string;
}

interface HeldWallet {
  readonly apiKey: string;
  readonly account: string;
  readonly client: OutLayerClient;
  readonly signer: TestnetSigner;
  readonly rail: TestnetRail;
}

export class TestnetServices {
  private readonly outlayerUrl: string;
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly statePath: string | undefined;
  private readonly restoreApiKey: string | undefined;
  private readonly priceOutbound: PriceSource | undefined;
  private wallet?: HeldWallet;
  /** Setup steps already attempted, so prepare is idempotent across calls. */
  private readonly prepared = new Set<string>();

  constructor(cfg: TestnetServicesConfig = {}) {
    this.outlayerUrl = cfg.outlayerUrl ?? "https://testnet-api.outlayer.ai";
    this.rpcUrl = cfg.nearRpcUrl ?? "https://rpc.testnet.fastnear.com";
    const inner = cfg.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      inner(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })) as typeof fetch;
    this.statePath = cfg.statePath;
    this.restoreApiKey = cfg.restoreApiKey;
    this.priceOutbound = cfg.priceOutbound;
  }

  get account(): string | undefined {
    return this.wallet?.account;
  }

  /**
   * Register a testnet wallet: reuse the persisted one when a state file holds
   * a key, else the environment-supplied key when one is configured, else ask
   * OutLayer for a new wallet and persist the key. OutLayer mints a fresh
   * account per register call, so without this the funded account — and any gas
   * sent to it — is orphaned on every restart.
   */
  async register(): Promise<{ account: string; reused: boolean }> {
    if (this.wallet) return { account: this.wallet.account, reused: true };

    const saved = this.readState();
    if (saved) {
      const held = await this.hold(saved.apiKey).catch(() => undefined);
      if (held) {
        this.wallet = held;
        return { account: held.account, reused: true };
      }
      // The saved key no longer works (revoked, wrong env): fall through and
      // mint a fresh wallet rather than refuse to start.
    }

    if (this.restoreApiKey) {
      const held = await this.hold(this.restoreApiKey).catch(() => undefined);
      if (held) {
        this.writeState({ apiKey: this.restoreApiKey, account: held.account });
        this.wallet = held;
        return { account: held.account, reused: true };
      }
      // The supplied key is invalid: fall through and mint rather than refuse.
    }

    const res = await this.fetchImpl(`${this.outlayerUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok || typeof body["api_key"] !== "string" || typeof body["near_account_id"] !== "string") {
      throw new Error(`testnet register failed: HTTP ${res.status}`);
    }
    const apiKey = body["api_key"] as string;
    const account = body["near_account_id"] as string;
    this.writeState({ apiKey, account });
    this.wallet = this.holdWallet(apiKey, account);
    return { account, reused: false };
  }

  /** Confirm a saved key still answers, and learn the account it belongs to. */
  private async hold(apiKey: string): Promise<HeldWallet | undefined> {
    const client = new OutLayerClient({ apiKey, baseUrl: this.outlayerUrl, fetchImpl: this.fetchImpl });
    const { address } = await client.address();
    if (!address) return undefined;
    return this.holdWallet(apiKey, address, client);
  }

  private holdWallet(apiKey: string, account: string, client?: OutLayerClient): HeldWallet {
    const held =
      client ?? new OutLayerClient({ apiKey, baseUrl: this.outlayerUrl, fetchImpl: this.fetchImpl });
    return {
      apiKey,
      account,
      client: held,
      signer: new TestnetSigner({ apiKey, baseUrl: this.outlayerUrl, fetchImpl: this.fetchImpl }),
      rail: new TestnetRail({ senderAccount: account, rpcUrl: this.rpcUrl, fetchImpl: this.fetchImpl }),
    };
  }

  private readState(): { apiKey: string; account?: string } | undefined {
    if (!this.statePath) return undefined;
    try {
      const raw = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as { apiKey?: unknown; account?: unknown };
      if (typeof parsed.apiKey !== "string" || !parsed.apiKey) return undefined;
      return {
        apiKey: parsed.apiKey,
        ...(typeof parsed.account === "string" ? { account: parsed.account } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private writeState(state: { apiKey: string; account: string }): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Persisting is best-effort: a read-only disk must not stop the API from
      // starting, it just means the next restart mints a fresh wallet.
    }
  }

  /** Live on-chain state of the held wallet, or disconnected. */
  async status(): Promise<TestnetStatus> {
    if (!this.wallet) return { connected: false };
    const acct = await this.viewAccount(this.wallet.account);
    const usdt = await this.tokenBalance(this.wallet.account);
    return {
      connected: true,
      account: this.wallet.account,
      gasYocto: acct.yocto.toString(),
      usdtBase: usdt.toString(),
    };
  }

  /**
   * Make a payout possible: gas must exist (only a human can send the first
   * NEAR — there is no programmatic faucet), then the wallet registers itself,
   * mints USDT.e, and registers the recipient. Steps run once each; a repeat
   * call reports what is already done rather than re-spending.
   */
  async prepare(recipient: string, minUsdtBase: bigint): Promise<PrepareResult> {
    const w = this.wallet;
    if (!w) throw new Error("register a testnet wallet first");
    const steps: PrepareStep[] = [];
    const acct = await this.viewAccount(w.account);
    if (!acct.exists || acct.yocto < MIN_GAS_YOCTO) {
      steps.push({ step: "gas", status: "failed", detail: `send testnet NEAR to ${w.account}` });
      return { steps, ready: false };
    }
    steps.push({ step: "gas", status: "ok", detail: `${acct.yocto} yocto` });

    if (this.prepared.has("storage")) {
      steps.push({ step: "storage_self", status: "skipped", detail: "already attempted" });
    } else {
      this.prepared.add("storage");
      const done = await this.outlayerCall(w, "storage_deposit", { account_id: w.account }, "storage", {
        deposit: STORAGE_YOCTO,
      });
      steps.push(
        done.ok
          ? { step: "storage_self", status: "ok" }
          : { step: "storage_self", status: "failed", detail: done.reason ?? "call failed" },
      );
    }

    if ((await this.tokenBalance(w.account)) < minUsdtBase && !this.prepared.has("mint")) {
      this.prepared.add("mint");
      // account_id deserializes on the fakes mint (verified live); receiver_id
      // is kept as fallback. The mint takes no attached deposit.
      const minted =
        ((await this.outlayerCall(w, "mint", { account_id: w.account, amount: MINT_BASE }, "mint-0", {
          gas: "100000000000000",
          deposit: "0",
        })) &&
          (await this.tokenBalance(w.account)) >= minUsdtBase) ||
        ((await this.outlayerCall(w, "mint", { receiver_id: w.account, amount: MINT_BASE }, "mint-1", {
          gas: "100000000000000",
          deposit: "0",
        })) &&
          (await this.tokenBalance(w.account)) >= minUsdtBase);
      steps.push(
        minted
          ? { step: "mint", status: "ok", detail: `${MINT_BASE} base units` }
          : { step: "mint", status: "failed", detail: `send mock USDT (${TESTNET_USDT}) to ${w.account}` },
      );
    } else {
      steps.push({ step: "mint", status: "skipped", detail: "balance sufficient or already attempted" });
    }

    const recipientKey = `recipient:${recipient}`;
    if (this.prepared.has(recipientKey)) {
      steps.push({ step: "storage_recipient", status: "skipped", detail: "already attempted" });
    } else {
      this.prepared.add(recipientKey);
      const done = await this.outlayerCall(
        w,
        "storage_deposit",
        { account_id: recipient },
        `storage-r-${this.prepared.size}`,
        { deposit: STORAGE_YOCTO },
      );
      steps.push(
        done.ok
          ? { step: "storage_recipient", status: "ok" }
          : { step: "storage_recipient", status: "failed", detail: done.reason ?? "call failed" },
      );
    }

    const ready =
      steps.every((s) => s.status !== "failed") && (await this.tokenBalance(w.account)) >= minUsdtBase;
    return { steps, ready };
  }

  /**
   * Mint mock USDT.e to the held wallet on demand. The console's faucet: gas
   * must already exist (only a human can send the first NEAR), then the wallet
   * registers itself once and mints. `amountBase` defaults to the standard
   * faucet amount; the mint is open on the fakes contract, so this is a real
   * on-chain mint of a mock token, not a simulation.
   */
  async mint(amountBase?: bigint): Promise<MintResult> {
    const w = this.wallet;
    if (!w) throw new Error("register a testnet wallet first");
    const steps: PrepareStep[] = [];
    const acct = await this.viewAccount(w.account);
    if (!acct.exists || acct.yocto < MIN_GAS_YOCTO) {
      steps.push({ step: "gas", status: "failed", detail: `send testnet NEAR to ${w.account}` });
      return { steps, ready: false, balanceBase: "0" };
    }
    steps.push({ step: "gas", status: "ok", detail: `${acct.yocto} yocto` });

    if (this.prepared.has("storage")) {
      steps.push({ step: "storage_self", status: "skipped", detail: "already attempted" });
    } else {
      this.prepared.add("storage");
      const done = await this.outlayerCall(w, "storage_deposit", { account_id: w.account }, "storage", {
        deposit: STORAGE_YOCTO,
      });
      steps.push(
        done.ok
          ? { step: "storage_self", status: "ok" }
          : { step: "storage_self", status: "failed", detail: done.reason ?? "call failed" },
      );
    }

    const amount = (amountBase && amountBase > 0n ? amountBase : BigInt(MINT_BASE)).toString();
    // account_id deserializes on the fakes mint (verified live); receiver_id is
    // the fallback. The mint takes no attached deposit (it panics on 1 yocto).
    const first = await this.outlayerCall(w, "mint", { account_id: w.account, amount }, "mint-0", {
      gas: "100000000000000",
      deposit: "0",
    });
    let minted = first.ok;
    if (!minted) {
      minted = (
        await this.outlayerCall(w, "mint", { receiver_id: w.account, amount }, "mint-1", {
          gas: "100000000000000",
          deposit: "0",
        })
      ).ok;
    }
    const balance = await this.tokenBalance(w.account);
    steps.push(
      minted
        ? { step: "mint", status: "ok", detail: `${amount} base units` }
        : { step: "mint", status: "failed", detail: `send mock USDT (${TESTNET_USDT}) to ${w.account}` },
    );

    return {
      steps,
      ready: minted,
      balanceBase: balance.toString(),
    };
  }

  /**
   * The adapters a testnet pay run settles through, once a wallet is held. The
   * rail is the cross-chain router: a NEAR corridor settles for real through
   * `TestnetRail`, and a corridor to another chain fails by name (with a live
   * 1Click price attached) instead of pretending to settle.
   */
  adapters(): { rail: SettlementRail; signer: TestnetSigner } | undefined {
    if (!this.wallet) return undefined;
    return {
      rail: new CrossChainRail({
        nearRail: this.wallet.rail,
        treasury: { chain: "near", asset: "usdt" },
        ...(this.priceOutbound ? { price: this.priceOutbound } : {}),
      }),
      signer: this.wallet.signer,
    };
  }

  private async outlayerCall(
    w: HeldWallet,
    method: string,
    args: Record<string, unknown>,
    key: string,
    opts?: { gas?: string; deposit?: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      const row = await w.client.callContract(TESTNET_USDT, method, args, `tn-${Date.now()}-${key}`, opts);
      const done = await this.awaitRow(w.client, row);
      return done.status === "success"
        ? { ok: true }
        : { ok: false, ...(done.reason ? { reason: done.reason } : { reason: done.status }) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "call failed";
      return { ok: false, reason: reason.slice(0, 200) };
    }
  }

  private async awaitRow(
    client: OutLayerClient,
    row: { request_id?: string; status: string },
  ): Promise<{ status: string; reason?: string }> {
    let current = row as { request_id?: string; status: string; result?: Record<string, unknown> };
    for (let i = 0; i < 15; i += 1) {
      const status = String(current.status);
      if (isTerminalStatus(status)) {
        const reason = current.result?.["reason"];
        return { status, ...(typeof reason === "string" ? { reason } : {}) };
      }
      if (!current.request_id) return { status };
      await new Promise<void>((r) => setTimeout(r, 2000));
      try {
        current = (await client.getRequest(current.request_id)) as typeof current;
      } catch {
        return { status: "read-failed" };
      }
    }
    return { status: "timeout" };
  }

  private async rpcCall(contract: string, method: string, args: Record<string, unknown>): Promise<bigint | undefined> {
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "testnet",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: contract,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
          },
        }),
      });
      const body = (await res.json()) as Record<string, any>;
      if (body["error"] || body["result"]?.["error"] || body["result"]?.["result"] === undefined) {
        return undefined;
      }
      const value: unknown = JSON.parse(Buffer.from(body["result"]["result"]).toString("utf8"));
      return typeof value === "string" ? BigInt(value) : undefined;
    } catch {
      return undefined;
    }
  }

  private async viewAccount(account: string): Promise<{ exists: boolean; yocto: bigint }> {
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "testnet",
          method: "query",
          params: { request_type: "view_account", finality: "final", account_id: account },
        }),
      });
      const body = (await res.json()) as Record<string, any>;
      if (body["error"]) return { exists: false, yocto: 0n };
      return { exists: true, yocto: BigInt(body["result"]["amount"] ?? "0") };
    } catch {
      return { exists: false, yocto: 0n };
    }
  }

  private async tokenBalance(account: string): Promise<bigint> {
    return (await this.rpcCall(TESTNET_USDT, "ft_balance_of", { account_id: account })) ?? 0n;
  }
}
