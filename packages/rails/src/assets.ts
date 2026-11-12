/**
 * Asset identity for 1Click. 1Click addresses every asset by a single string
 * id, not by chain plus contract, so the mapping from Crewpay's `chain:asset`
 * pair to that id is load-bearing: a wrong id sends funds to the wrong asset.
 *
 * The ids below were read from the live `GET /v0/tokens` list. Prefer
 * `AssetRegistry.fromApi()` at runtime so ids and decimals come from the
 * service rather than from this table, and treat the table as the offline
 * fallback plus the test fixture.
 */

export interface TokenInfo {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  /** Last price in USD, as reported by 1Click. */
  readonly priceUsd: number;
}

export const TOKENS_API_PATH = "/v0/tokens";

/** Offline fallback, verified against `GET /v0/tokens` on 2026-11-12. */
export const KNOWN_TOKENS: readonly TokenInfo[] = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", priceUsd: 0 },
  { assetId: "nep141:usdt.tether-token.near", decimals: 6, blockchain: "near", symbol: "USDT", priceUsd: 1 },
  {
    assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    blockchain: "near",
    symbol: "USDC",
    priceUsd: 1,
  },
  { assetId: "nep141:base.omft.near", decimals: 18, blockchain: "base", symbol: "ETH", priceUsd: 0 },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    priceUsd: 1,
  },
  { assetId: "nep141:arb.omft.near", decimals: 18, blockchain: "arb", symbol: "ETH", priceUsd: 0 },
  {
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    blockchain: "arb",
    symbol: "USDC",
    priceUsd: 1,
  },
  { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH", priceUsd: 0 },
  {
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    decimals: 6,
    blockchain: "eth",
    symbol: "USDC",
    priceUsd: 1,
  },
  {
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    decimals: 6,
    blockchain: "sol",
    symbol: "USDC",
    priceUsd: 1,
  },
  { assetId: "nep141:btc.omft.near", decimals: 8, blockchain: "btc", symbol: "BTC", priceUsd: 0 },
];

export class UnknownAssetError extends Error {
  constructor(chain: string, symbol: string) {
    super(`no 1Click asset id known for ${chain}:${symbol}`);
    this.name = "UnknownAssetError";
  }
}

/** A chain plus asset pair, as Crewpay models it. */
export interface ChainAssetKey {
  readonly chain: string;
  readonly asset: string;
}

/**
 * Maps `chain:asset` to the 1Click asset id and carries decimals so callers
 * never hardcode a base-unit multiplier.
 */
export class AssetRegistry {
  private readonly byKey: Map<string, TokenInfo>;
  private readonly byId: Map<string, TokenInfo>;

  private constructor(tokens: readonly TokenInfo[]) {
    this.byKey = new Map();
    this.byId = new Map();
    for (const t of tokens) {
      this.byKey.set(key(t.blockchain, t.symbol), t);
      this.byId.set(t.assetId, t);
    }
    // 1Click lists native NEAR under its wrapped symbol; accept either spelling.
    for (const [from, to] of SYMBOL_ALIASES) {
      const info = this.byKey.get(from);
      if (info) this.byKey.set(to, info);
    }
  }

  static fromTokens(tokens: readonly TokenInfo[]): AssetRegistry {
    return new AssetRegistry(tokens);
  }

  /** The offline table. Use `fromApi` in production. */
  static known(): AssetRegistry {
    return new AssetRegistry(KNOWN_TOKENS);
  }

  /** Fetch the live list. Any 1Click id will be resolvable afterwards. */
  static async fromApi(fetchImpl: typeof fetch, baseUrl: string, apiKey?: string): Promise<AssetRegistry> {
    const res = await fetchImpl(`${baseUrl}${TOKENS_API_PATH}`, {
      method: "GET",
      headers: apiKey ? { "X-API-Key": apiKey } : {},
    });
    if (!res.ok) throw new Error(`1Click tokens failed: ${res.status}`);
    const raw = (await res.json()) as readonly {
      assetId: string;
      decimals: number;
      blockchain: string;
      symbol: string;
      price?: number | string;
    }[];
    return new AssetRegistry(
      raw.map((t) => ({
        assetId: t.assetId,
        decimals: t.decimals,
        blockchain: t.blockchain,
        symbol: t.symbol,
        priceUsd: Number(t.price ?? 0),
      })),
    );
  }

  get(chain: string, symbol: string): TokenInfo | undefined {
    return this.byKey.get(key(chain, symbol));
  }

  require(chain: string, symbol: string): TokenInfo {
    const info = this.get(chain, symbol);
    if (!info) throw new UnknownAssetError(chain, symbol);
    return info;
  }

  byAssetId(assetId: string): TokenInfo | undefined {
    return this.byId.get(assetId);
  }

  /** Convert a decimal amount to the asset's smallest unit, exactly. */
  toBaseUnits(amount: number, chain: string, symbol: string): bigint {
    const info = this.require(chain, symbol);
    return decimalToBaseUnits(amount, info.decimals);
  }
}

function key(chain: string, symbol: string): string {
  return `${chain.toLowerCase()}:${symbol.toUpperCase()}`;
}

/** `[from, to]` pairs applied on top of the token list, in `key()` format. */
const SYMBOL_ALIASES: readonly (readonly [string, string])[] = [["near:WNEAR", "near:NEAR"]];

/**
 * Decimal to base units without floating point error: the decimal string is
 * split at the point and padded, so `0.1` becomes `100000n` at 6 decimals.
 */
export function decimalToBaseUnits(amount: number | string, decimals: number): bigint {
  const s = typeof amount === "number" ? amount.toString() : amount;
  if (s.includes("e") || s.includes("E")) {
    return decimalToBaseUnits(BigInt(Math.round(Number(s))).toString(), decimals);
  }
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const magnitude = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return negative ? -magnitude : magnitude;
}

/** Base units to a decimal string, for display and CSV export. */
export function baseUnitsToDecimal(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const frac = (magnitude % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
