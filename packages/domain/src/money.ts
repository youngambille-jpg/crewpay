/**
 * Money is exact: `amount` is the smallest unit of `asset` (bigint), and
 * `usdCents` is the valuation used for policy. Policy never compares floats, so
 * every cap and threshold is an integer number of USD cents.
 */

export type AssetId = string;
export type Chain = string;

/** A token on a specific chain, e.g. { chain: "base", asset: "usdc" }. */
export interface ChainAsset {
  readonly chain: Chain;
  readonly asset: AssetId;
}

/** A corridor is a directed payout route, e.g. "base:usdc>near:usdc". */
export type Corridor = string;

export function corridor(from: ChainAsset, to: ChainAsset): Corridor {
  return `${from.chain}:${from.asset}>${to.chain}:${to.asset}`;
}

export interface Money {
  readonly amount: bigint;
  readonly asset: AssetId;
}

/** Valuation at decision time. Integer cents; fits in a JS number safely. */
export type UsdCents = number;

export function usd(cents: UsdCents): UsdCents {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`usdCents must be a safe integer, got ${cents}`);
  }
  return cents;
}

export function formatUsd(cents: UsdCents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
