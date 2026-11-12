import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AssetRegistry,
  UnknownAssetError,
  baseUnitsToDecimal,
  decimalToBaseUnits,
  KNOWN_TOKENS,
} from "./assets.ts";

test("resolves the live USDC-on-NEAR id, not a guessed one", () => {
  const r = AssetRegistry.known();
  assert.equal(
    r.require("near", "usdc").assetId,
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  );
});

test("chain aliases resolve (arbitrum -> arb, solana -> sol)", () => {
  const r = AssetRegistry.known();
  assert.equal(r.require("arb", "usdc").assetId, r.require("arb", "USDC").assetId);
  assert.equal(r.byAssetId("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")?.symbol, "USDC");
});

test("an unknown asset is reported, not guessed", () => {
  assert.throws(() => AssetRegistry.known().require("near", "wif"), UnknownAssetError);
});

test("native NEAR resolves under either spelling", () => {
  const r = AssetRegistry.known();
  assert.equal(r.require("near", "near").assetId, "nep141:wrap.near");
  assert.equal(r.require("near", "wNEAR").assetId, "nep141:wrap.near");
});

test("decimal to base units is exact for the cases floats get wrong", () => {
  assert.equal(decimalToBaseUnits("0.1", 6), 100_000n);
  assert.equal(decimalToBaseUnits(0.1, 6), 100_000n);
  assert.equal(decimalToBaseUnits("1.000001", 6), 1_000_001n);
  assert.equal(decimalToBaseUnits("1", 24), 10n ** 24n);
  assert.equal(decimalToBaseUnits("0.000000001", 8), 0n);
  assert.equal(decimalToBaseUnits("123.456", 8), 12_345_600_000n);
});

test("base units to decimal round-trips", () => {
  assert.equal(baseUnitsToDecimal(100_000n, 6), "0.1");
  assert.equal(baseUnitsToDecimal(1_000_000n, 6), "1");
  assert.equal(baseUnitsToDecimal(0n, 6), "0");
  assert.equal(baseUnitsToDecimal(12_345_600_000n, 8), "123.456");
});

test("toBaseUnits uses the token's own decimals", () => {
  const r = AssetRegistry.known();
  assert.equal(r.toBaseUnits(1, "near", "usdc"), 1_000_000n);
  assert.equal(r.toBaseUnits(1, "eth", "eth"), 10n ** 18n);
  assert.equal(r.toBaseUnits(1, "btc", "btc"), 100_000_000n);
});

test("fromApi builds a registry from the live token shape", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify([
        { assetId: "nep141:new-token.near", decimals: 9, blockchain: "near", symbol: "NEW", price: 2.5 },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  const r = await AssetRegistry.fromApi(fakeFetch, "https://1click.chaindefuser.com");
  assert.equal(r.require("near", "new").assetId, "nep141:new-token.near");
  assert.equal(r.require("near", "new").priceUsd, 2.5);
});

test("the offline table stays in sync with the live ids we depend on", () => {
  const ids = new Set(KNOWN_TOKENS.map((t) => t.assetId));
  assert.ok(ids.has("nep141:usdt.tether-token.near"));
  assert.ok(ids.has("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"));
});
