import type { AgentTask, Approval, ChainAsset, Invoice, Operation, PayRun, PayRunItem, Payee, Policy } from "@crewpay/domain";
import type { JournalEntry } from "@crewpay/ledger";

export interface Store {
  payees: Map<string, Payee>;
  payRuns: Map<string, PayRun>;
  payRunItems: Map<string, PayRunItem[]>;
  operations: Map<string, Operation>;
  policies: Map<string, Policy>;
  approvals: Map<string, Approval>;
  /** payeeId -> number of previously settled payments. */
  payeeHistory: Map<string, number>;
  /** orgId -> USD cents settled today, for the daily cap on approvals. */
  settledTodayCents: Map<string, number>;
  invoices: Map<string, Invoice>;
  /** invoiceId -> the pay run to open when the invoice is paid. */
  invoicePayRuns: Map<string, { payeeId: string; origin?: ChainAsset }>;
  /** eventId -> seen marker, so a retried webhook is not acted on twice. */
  webhookEvents: Map<string, { type: string; at: string }>;
  /** Agent tasks, by id. A task is the claim; its payout is the money movement. */
  agentTasks: Map<string, AgentTask>;
  /**
   * Every journal entry written, in insertion order. Money movement is only
   * real if the books record it, so the entries are stored rather than returned
   * and dropped.
   */
  journalEntries: JournalEntry[];
  /**
   * Funding requests whose outcome is not fully resolved, keyed by the custody
   * service's request id. An outcome is a snapshot; when it was `needs_review`,
   * or a failure that is not safe to retry, the funds may have moved and the
   * only way to learn the truth is to re-read the request. Keeping the handle
   * is what makes that possible — without it the state is unrecoverable.
   */
  fundingRequests: Map<string, FundingRecord>;
}

/**
 * A funding request we are tracking. It records what we believed at the time
 * and when; the service row is the authority, this is the worklist.
 */
export interface FundingRecord {
  readonly requestId: string;
  readonly orgId: string;
  readonly operationId: string;
  /** The outcome kind we recorded, e.g. `needs_review` or `failed`. */
  readonly kind: "pending" | "failed" | "needs_review";
  readonly reason: string;
  /** Present when `kind` is `failed`. */
  readonly safeToRetry?: boolean;
  readonly createdAt: string;
}

export function createStore(): Store {
  return {
    payees: new Map(),
    payRuns: new Map(),
    payRunItems: new Map(),
    operations: new Map(),
    policies: new Map(),
    approvals: new Map(),
    payeeHistory: new Map(),
    settledTodayCents: new Map(),
    invoices: new Map(),
    invoicePayRuns: new Map(),
    webhookEvents: new Map(),
    agentTasks: new Map(),
    journalEntries: [],
    fundingRequests: new Map(),
  };
}

export function activePolicy(store: Store, orgId: string): Policy | undefined {
  for (const policy of store.policies.values()) {
    if (policy.orgId === orgId && policy.active) return policy;
  }
  return undefined;
}

/**
 * Keep a funding request we could not resolve, so it can be re-read later.
 *
 * Only unresolved outcomes are kept: `deposited` is done, and a failure that is
 * safe to retry carries no open question. What must not be lost is a
 * `needs_review`, a `pending`, or a failure that is *not* safe to retry — in all
 * three the funds may have moved and the request id is the only way back to the
 * truth.
 *
 * A record is replaced by a newer one for the same request id, so a request
 * that escalates from `pending` to `needs_review` does not appear twice.
 */
export function recordFunding(
  store: Store,
  ctx: { orgId: string; operationId: string },
  funding: { kind: string; reason?: string; safeToRetry?: boolean; requestId?: string } | undefined,
): void {
  if (!funding || !funding.requestId) return;
  if (funding.kind === "deposited") return;
  if (funding.kind === "failed" && funding.safeToRetry) return;

  store.fundingRequests.set(funding.requestId, {
    requestId: funding.requestId,
    orgId: ctx.orgId,
    operationId: ctx.operationId,
    kind: funding.kind as "pending" | "failed" | "needs_review",
    reason: funding.reason ?? "",
    ...(funding.kind === "failed" ? { safeToRetry: funding.safeToRetry ?? false } : {}),
    createdAt: new Date().toISOString(),
  });
}
