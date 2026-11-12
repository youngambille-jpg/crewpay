/**
 * Drift guard: the offline asset table in `packages/rails/src/assets.ts` must
 * match the live 1Click token list. Run before shipping a rail change, or in CI
 * on a schedule. Exits non-zero when an id we depend on has moved.
 *
 *   npm run verify:tokens
 */
import { AssetRegistry, KNOWN_TOKENS } from "@crewpay/rails";

const BASE_URL = process.env["ONECLICK_BASE_URL"] ?? "https://1click.chaindefuser.com";
const API_KEY = process.env["ONECLICK_API_KEY"];

const live = await AssetRegistry.fromApi(fetch, BASE_URL, API_KEY);

const mismatches: string[] = [];
for (const token of KNOWN_TOKENS) {
  const found = live.get(token.blockchain, token.symbol);
  if (!found) {
    mismatches.push(`${token.blockchain}:${token.symbol} not offered by 1Click`);
    continue;
  }
  if (found.assetId !== token.assetId) {
    mismatches.push(`${token.blockchain}:${token.symbol} moved ${token.assetId} -> ${found.assetId}`);
  }
  if (found.decimals !== token.decimals) {
    mismatches.push(`${token.blockchain}:${token.symbol} decimals ${token.decimals} -> ${found.decimals}`);
  }
}

if (mismatches.length > 0) {
  console.error(`asset table drift detected (${mismatches.length}):`);
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

console.log(`ok: all ${KNOWN_TOKENS.length} pinned assets match the live 1Click list`);
