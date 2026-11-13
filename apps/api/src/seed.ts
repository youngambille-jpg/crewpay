/**
 * A seeded org, used by the demo, the served API and the dashboard. Kept in one
 * place so the numbers the dashboard shows are the same numbers `npm run demo`
 * prints — a dashboard that invents its own data proves nothing.
 *
 * The seed is deliberately shaped so every policy outcome appears at least once:
 * two contractors settle, one vendor crosses the approval threshold, and the
 * agent is over its per-kind cap and is denied.
 */
import type { ApiDeps } from "./server.ts";
import type { Store } from "./store.ts";
import type { AddressInfo } from "node:net";

export const ORG_ID = "org_1";

export const SEED_PAYEES = [
  {
    id: "ada",
    kind: "contractor" as const,
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    destination: { chain: "near", asset: "usdc" },
    address: "ada.near",
    status: "approved" as const,
    screening: "clear" as const,
  },
  {
    id: "linus",
    kind: "contractor" as const,
    displayName: "Linus T.",
    email: "linus@example.com",
    destination: { chain: "arbitrum", asset: "usdc" },
    address: "0x1inus000000000000000000000000000000000001",
    status: "approved" as const,
    screening: "clear" as const,
  },
  {
    id: "shopify-agency",
    kind: "vendor" as const,
    displayName: "Northwind Agency",
    email: "invoices@northwind.co",
    destination: { chain: "base", asset: "usdc" },
    address: "0xagency00000000000000000000000000000000002",
    status: "approved" as const,
    screening: "clear" as const,
  },
  {
    id: "gpt-worker",
    kind: "agent" as const,
    displayName: "research-bot",
    destination: { chain: "near", asset: "usdc" },
    address: "agent.near",
    status: "approved" as const,
    screening: "clear" as const,
  },
  {
    id: "pending-dev",
    kind: "contractor" as const,
    displayName: "Priya (onboarding)",
    email: "priya@example.com",
    destination: { chain: "near", asset: "usdc" },
    address: "priya.near",
    status: "draft" as const,
    screening: "review" as const,
  },
];

export const SEED_RULES = {
  maxPerTransactionCents: 500_000,
  maxDailyCents: 5_000_000,
  approvalThresholdCents: 200_000,
  allowedPayeeKinds: ["contractor", "vendor", "employee", "agent"] as const,
  allowedCorridors: [] as readonly string[],
  allowedAssets: ["usdc", "usdt", "dai"],
  perKindCents: { agent: 50_000 },
  requireApprovalForNewPayee: false,
};

type Call = (path: string, method: string, body?: unknown) => Promise<{ status: number; json: any }>;

/**
 * Seed payees and a policy through the real HTTP surface, so the seed travels
 * the same path a real caller would. Returns nothing; callers then post runs.
 */
export async function seedOrg(call: Call): Promise<void> {
  for (const p of SEED_PAYEES) {
    await call("/v1/payees", "POST", { orgId: ORG_ID, ...p });
  }
  await call("/v1/policies", "POST", { orgId: ORG_ID, rules: SEED_RULES });
}

/**
 * The demo pay run: four lines covering settle, approve, and deny. Slow
 * operation 3 and a needs-review on operation 2 are what make the worklist and
 * the approval inbox non-empty — the two screens a dashboard most needs to show.
 */
export async function seedPayRun(call: Call): Promise<any> {
  return (
    await call("/v1/pay-runs", "POST", {
      orgId: ORG_ID,
      period: new Date().toISOString().slice(0, 7),
      lines: [
        { payeeId: "ada", usdCents: 150_000 },
        { payeeId: "linus", usdCents: 120_000 },
        { payeeId: "shopify-agency", usdCents: 250_000 },
        { payeeId: "gpt-worker", usdCents: 80_000 },
      ],
    })
  ).json;
}
