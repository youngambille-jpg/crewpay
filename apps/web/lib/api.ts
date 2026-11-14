/**
 * Typed access to the CrewPay control plane.
 *
 * Server components fetch the API process directly (API_ORIGIN); client
 * components go through the `/api/*` rewrite so the browser stays same-origin.
 * Both are the same real endpoints — nothing here is mocked.
 *
 * Money crosses the wire as strings (the API serialises bigint that way), so
 * base-unit fields are typed `string`. USD valuations are integer cents.
 */

export const ORG_ID = "org_1";

const SERVER_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";

/** Origin to use from a server component. */
function serverUrl(path: string): string {
  return `${SERVER_ORIGIN}${path}`;
}

/** Origin to use from the browser (the Next rewrite). */
function clientUrl(path: string): string {
  return `/api${path}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(path: string, server: boolean): Promise<T> {
  const url = server ? serverUrl(path) : clientUrl(path);
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json()) as T | { error: string };
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? "request failed";
    throw new ApiError(res.status, message);
  }
  return body as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(clientUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T | { error: string };
  if (!res.ok) {
    const message = (json as { error?: string }).error ?? "request failed";
    throw new ApiError(res.status, message);
  }
  return json as T;
}

/* ------------------------------- types ------------------------------- */

export interface ChainAsset {
  chain: string;
  asset: string;
}

export interface Payee {
  id: string;
  orgId: string;
  kind: "contractor" | "vendor" | "employee" | "agent";
  displayName: string;
  email?: string;
  destination: ChainAsset;
  address: string;
  status: "draft" | "approved" | "blocked";
  screening: "clear" | "review" | "hit";
  riskScore?: number;
}

export interface PayRunItem {
  id: string;
  payRunId: string;
  payeeId: string;
  amount: { amount: string; asset: string };
  corridor: string;
  operationId?: string;
  state: string;
}

export interface PayRun {
  id: string;
  orgId: string;
  source: string;
  period: string;
  currency: string;
  status: string;
  createdBy: string;
  createdAt: string;
  items: PayRunItem[];
}

export interface Operation {
  id: string;
  type: string;
  amount: { amount: string; asset: string };
  usdCents: number;
  corridor: string;
  recipient: string;
}

export interface Approval {
  id: string;
  orgId: string;
  operationId: string;
  operation: Operation;
  payeeId: string;
  policyId: string;
  policyVersion: number;
  reasonCodes: string[];
  status: string;
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface FundingRecord {
  requestId: string;
  orgId: string;
  operationId: string;
  payeeId?: string;
  kind: "pending" | "failed" | "needs_review";
  reason: string;
  settlesVia?: "rail" | "agentpay";
  resolution?: "settled" | "failed";
  resolutionNote?: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  orgId: string;
  customerId: string;
  amount: number;
  settlementAsset: ChainAsset;
  status: "open" | "paid" | "expired" | "cancelled" | "failed";
  checkoutSessionId: string;
  checkoutUrl: string;
  createdAt: string;
  paidAt?: string;
}

export interface AgentTask {
  id: string;
  orgId: string;
  payeeId: string;
  protocol: string;
  resourceUrl: string;
  amountOut: string;
  usdCents: number;
  status: string;
  createdAt: string;
  description?: string;
  note?: string;
  receipt?: { operationToken: string; txHash: string; settledAt: string };
}

export interface TrialBalanceRow {
  account: string;
  currency: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface Ledger {
  orgId: string;
  entries: {
    id: string;
    kind: string;
    memo: string;
    postings: { account: string; direction: string; amount: string; currency: string }[];
    createdAt: string;
  }[];
  trialBalance: TrialBalanceRow[];
  balanced: boolean;
  unbalancedCurrencies?: string[];
  attestation: string;
  entryCount: number;
}

export interface PolicyRules {
  maxPerTransactionCents: number;
  maxDailyCents: number;
  approvalThresholdCents: number;
  allowedPayeeKinds: string[];
  allowedCorridors: string[];
  allowedAssets: string[];
  perKindCents?: Record<string, number>;
  requireApprovalForNewPayee: boolean;
  maxPayeeRiskScore?: number;
}

export interface Policy {
  id: string;
  orgId: string;
  version: number;
  active: boolean;
  rules: PolicyRules;
}

export interface ManifestView {
  policyId: string;
  policyVersion: number;
  manifest: {
    limits: { per_transaction: string; daily: string };
    tokens: { allowed: string[] };
    multisig: { approvers: string[]; threshold: number; approval_above: string };
    chains: { allowed: string[] };
  };
  warnings: string[];
  drift?: { kind: string; path: string; detail?: string }[];
}

export interface AgentPaymentsExport {
  orgId: string;
  year: string;
  rows: {
    payeeId: string;
    displayName: string;
    totalUsd: string;
    totalUsdCents: number;
    payments: number;
    meetsReportingThreshold: boolean;
  }[];
}

export interface Health {
  ok: boolean;
  rail: string;
}

/* ------------------------- live infrastructure ------------------------- */

export type ServiceStatus = "ok" | "down" | "skipped";

export interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  detail: string;
  ms: number;
}

export interface LiveHealth {
  mode: "demo" | "live";
  checkedAt: string;
  services: ServiceHealth[];
  allUp: boolean;
}

export interface LiveWallet {
  walletId: string;
  nearAccountId: string;
  createdAt: string;
}

export interface ConnectState {
  connected: boolean;
  wallet?: LiveWallet;
  funded?: boolean;
  /** True when the provider offered a dashboard link. The URL itself is never sent. */
  hasHandoff?: boolean;
  note?: string;
}

export interface PolicyCheck {
  withinLimits: boolean;
  addressAllowed: boolean;
}

export interface DryRunResult {
  wouldSucceed: boolean;
  reason?: string;
  message?: string;
  policyCheck?: PolicyCheck;
}

export interface SignedPolicy {
  signature: string;
  publicKey: string;
  version: number;
  policyHash: string;
  validUntil: number;
}

export interface PublishResult {
  published: boolean;
  walletId: string;
  ciphertext: string;
  ciphertextBytes: number;
  signed: SignedPolicy;
  policyState: "none" | "compiled" | "stored";
  note: string;
}

export interface CustodyState {
  connected: boolean;
  policy?: Record<string, unknown>;
  policyState?: "none" | "compiled" | "stored";
  policyVersion?: number;
  intentsBalance?: string;
}

/* ---------------------------- read helpers ---------------------------- */

export const api = {
  health: (server = true) => get<Health>("/health", server),
  payees: (server = true) => get<Payee[]>(`/v1/payees?orgId=${ORG_ID}`, server),
  payRuns: (server = true) => get<PayRun[]>(`/v1/pay-runs?orgId=${ORG_ID}`, server),
  approvals: (server = true) => get<Approval[]>(`/v1/approvals?orgId=${ORG_ID}`, server),
  worklist: (server = true) => get<FundingRecord[]>(`/v1/custody/requests?orgId=${ORG_ID}`, server),
  invoices: (server = true) => get<Invoice[]>(`/v1/invoices?orgId=${ORG_ID}`, server),
  agentTasks: (server = true) => get<AgentTask[]>(`/v1/agent-tasks?orgId=${ORG_ID}`, server),
  ledger: (server = true) => get<Ledger>(`/v1/ledger?orgId=${ORG_ID}`, server),
  policy: (server = true) => get<Policy>(`/v1/policies?orgId=${ORG_ID}`, server),
  manifest: (server = true) =>
    get<ManifestView>(`/v1/manifest?orgId=${ORG_ID}&approvers=owner.near&threshold=1`, server),
  agentExport: (server = true) =>
    get<AgentPaymentsExport>(`/v1/exports/agent-payments?orgId=${ORG_ID}`, server),

  /* --------------------------- write actions --------------------------- */

  decide: (id: string, action: "approve" | "reject", note?: string) =>
    post<Approval>(`/v1/approvals/${id}/${action}`, {
      decidedBy: "owner@acme",
      ...(note ? { note } : {}),
    }),

  execute: (id: string) =>
    post<{ status: string; approval: Approval; reasons?: string[] }>(
      `/v1/approvals/${id}/execute`,
      {},
    ),

  resolveFunding: (requestId: string) =>
    post<{ resolved: boolean; outcome: string; reason?: string; duplicate?: boolean }>(
      `/v1/custody/requests/${encodeURIComponent(requestId)}/resolve`,
      {},
    ),

  createPayRun: (period: string, lines: { payeeId: string; usdCents: number }[]) =>
    post<{
      run: PayRun;
      settledCents: number;
      approvals: string[];
      denied: unknown[];
      needsReview: unknown[];
    }>("/v1/pay-runs", { orgId: ORG_ID, period, lines }),

  addPayee: (
    payee: Partial<Payee> & {
      id: string;
      kind: Payee["kind"];
      displayName: string;
      destination: ChainAsset;
      address: string;
    },
  ) => post<Payee>("/v1/payees", { orgId: ORG_ID, status: "draft", screening: "review", ...payee }),

  createInvoice: (customerId: string, amountCents: number, autoPayeeId?: string) =>
    post<Invoice>("/v1/invoices", {
      orgId: ORG_ID,
      customerId,
      amount: amountCents,
      ...(autoPayeeId ? { autoPayRun: { payeeId: autoPayeeId } } : {}),
    }),

  payAgentTask: (payeeId: string, usdCents: number, resourceUrl: string, description?: string) =>
    post<{ task: AgentTask; status: string; reasons?: string[] }>("/v1/agent-tasks", {
      orgId: ORG_ID,
      payeeId,
      resourceUrl,
      amountOut: String(usdCents * 10_000),
      usdCents,
      ...(description ? { description } : {}),
    }),

  setPolicy: (rules: Partial<PolicyRules>) => post<Policy>("/v1/policies", { orgId: ORG_ID, rules }),

  /* --------------------------- live services --------------------------- */

  /** Real health of 1Click, OutLayer and Ping. Cheap enough to call on load. */
  liveHealth: (server = true) => get<LiveHealth>("/v1/live/health", server),

  /** Provision a real OutLayer custody wallet. The `wk_` key stays server-side. */
  connect: () => post<ConnectState>("/v1/connect", {}),

  connectState: (server = true) => get<ConnectState>("/v1/connect", server),

  /**
   * Compile the org's rules into the blob the TEE enforces, and sign it. Storing
   * it on-chain needs a funded account, so this stops at `compiled`.
   */
  publishPolicy: (rules: Partial<PolicyRules>) =>
    post<PublishResult>("/v1/policies/publish", { orgId: ORG_ID, rules }),

  /** Ask the TEE whether a withdraw would pass. No signing, no broadcast. */
  dryRun: (req: { chain: string; amount: string; to: string; token?: string }) =>
    post<DryRunResult>("/v1/live/dry-run", req),

  /** The policy the enclave actually enforces, and the intents balance. */
  custody: (server = true) => get<CustodyState>("/v1/live/custody", server),
};

/* ------------------------------ formatting ------------------------------ */

/** Format integer USD cents as $1,234.56. */
export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Shorten a long address for a table cell. */
export function short(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** A human label for an outcome/status token. */
export function label(s: string): string {
  return s.replace(/_/g, " ");
}

/** Relative time from an ISO string. */
export function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
