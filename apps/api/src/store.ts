import type { AgentTask, Approval, ChainAsset, Invoice, Operation, OperationStatus, PayRun, PayRunItem, Payee, Policy } from "@crewpay/domain";
import type { JournalEntry } from "@crewpay/ledger";
import type { Quote } from "@crewpay/rails";

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
  /**
   * The policy decision and settlement state of every pay-run operation, keyed
   * by operation id. The Operation is the proposed money movement; this is what
   * the loop decided and did with it, so the outcome survives the request.
   */
  operationRecords: Map<string, OperationRecord>;
  /**
   * Terminal proof per settled operation, linking the journal entry to its
   * on-chain evidence. A settlement the books cannot trace to a transaction is
   * a number someone typed.
   */
  receipts: Map<string, SettlementReceipt>;
  /**
   * Notification outbox, in insertion order. Delivery (email, webhook push) is
   * not wired to a provider, so each event is recorded with its audience
   * instead of being dropped — the log is what a sender would drain.
   */
  notifications: Notification[];
}

/** The policy engine's verdict, restated here so the store stays dependency-free. */
export type PolicyDecision = "allow" | "allow_with_approval" | "deny";

/**
 * What the loop decided and did with one operation. Written when the operation
 * is evaluated and updated as it settles, fails, or waits — the run summary
 * and the operations list read this, not the transient run result.
 */
export interface OperationRecord {
  readonly operationId: string;
  readonly orgId: string;
  readonly payeeId: string;
  readonly payRunId?: string;
  readonly decision: PolicyDecision;
  readonly reasonCodes: readonly string[];
  readonly policyId: string;
  readonly policyVersion: number;
  readonly status: OperationStatus | "pending";
  readonly quoteId?: string;
  readonly txHash?: string;
  readonly evidence?: string;
  readonly journalEntryId?: string;
  readonly note?: string;
  readonly updatedAt: string;
}

/** Links one journal entry to the chain transaction that settled it. */
export interface SettlementReceipt {
  readonly operationId: string;
  readonly journalEntryId: string;
  readonly quoteId?: string;
  readonly txHash?: string;
  readonly evidence?: string;
  readonly settledAt: string;
}

export type NotificationKind =
  | "payee_paid"
  | "payee_denied"
  | "approval_needed"
  | "approval_decided"
  | "payout_failed"
  | "payout_needs_review";

export interface Notification {
  readonly id: string;
  readonly orgId: string;
  readonly kind: NotificationKind;
  /** Who should hear it: a payee id, or `owner` for the human operator. */
  readonly to: string;
  readonly refType: "pay_run" | "operation" | "approval" | "funding_request";
  readonly refId: string;
  readonly message: string;
  readonly createdAt: string;
}

/**
 * A funding request we are tracking. It records what we believed at the time
 * and when; the service row is the authority, this is the worklist.
 *
 * `railQuote` is what makes resolution possible: re-reading tells us the
 * *deposit* landed, but the deposit address in the quote is the only key the
 * rail will answer a settlement status for. Without it we could confirm the
 * money left but never learn whether the payee was paid.
 */
export interface FundingRecord {
  readonly requestId: string;
  readonly orgId: string;
  readonly operationId: string;
  /** Who is owed the money, so a late settlement still counts as history. */
  readonly payeeId?: string;
  /** The outcome kind we recorded, e.g. `needs_review` or `failed`. */
  readonly kind: "pending" | "failed" | "needs_review";
  readonly reason: string;
  /** Present when `kind` is `failed`. */
  readonly safeToRetry?: boolean;
  /** The rail quote for this deposit, needed to poll for the settlement. */
  readonly railQuote?: Quote;
  /**
   * Which settlement port owns this deposit. A pay run and an approval settle
   * through the 1Click rail; an agent task settles through the x402 facilitator.
   * They are different services, so polling the wrong one with this deposit
   * address would answer about something else. Defaults to `rail`.
   */
  readonly settlesVia?: "rail" | "agentpay";
  /**
   * Set once the open question is answered. A resolved record is kept rather
   * than deleted so a repeated resolve is idempotent: the second call can see
   * the answer and report it instead of 404-ing, which a caller retrying after
   * a lost response could not distinguish from "never existed". Resolved
   * records are hidden from the worklist, which is what it is for.
   */
  readonly resolution?: "settled" | "failed";
  readonly resolvedAt?: string;
  /** What resolving concluded, e.g. the rail's failure reason. */
  readonly resolutionNote?: string;
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
    operationRecords: new Map(),
    receipts: new Map(),
    notifications: [],
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
  ctx: {
    orgId: string;
    operationId: string;
    payeeId?: string;
    railQuote?: Quote;
    settlesVia?: "rail" | "agentpay";
  },
  funding: { kind: string; reason?: string; safeToRetry?: boolean; requestId?: string } | undefined,
): void {
  if (!funding || !funding.requestId) return;
  if (funding.kind === "deposited") return;
  if (funding.kind === "failed" && funding.safeToRetry) return;

  store.fundingRequests.set(funding.requestId, {
    requestId: funding.requestId,
    orgId: ctx.orgId,
    operationId: ctx.operationId,
    ...(ctx.payeeId ? { payeeId: ctx.payeeId } : {}),
    kind: funding.kind as "pending" | "failed" | "needs_review",
    reason: funding.reason ?? "",
    ...(funding.kind === "failed" ? { safeToRetry: funding.safeToRetry ?? false } : {}),
    ...(ctx.railQuote ? { railQuote: ctx.railQuote } : {}),
    ...(ctx.settlesVia ? { settlesVia: ctx.settlesVia } : {}),
    createdAt: new Date().toISOString(),
  });
}

/**
 * Record that a funding request's open question is answered.
 *
 * The record is marked, not deleted, so a repeated resolve is idempotent: a
 * caller retrying after a lost response must be able to tell "already resolved"
 * from "never existed". The worklist filters resolved records out, which is
 * what it is for — finding the ones that still need a human.
 */
export function resolveFundingRecord(
  store: Store,
  requestId: string,
  resolution: "settled" | "failed",
  note?: string,
): void {
  const record = store.fundingRequests.get(requestId);
  if (!record) return;
  store.fundingRequests.set(requestId, {
    ...record,
    resolution,
    resolvedAt: new Date().toISOString(),
    ...(note ? { resolutionNote: note } : {}),
  });
}

export interface OutcomeInput {
  readonly orgId: string;
  readonly operationId: string;
  readonly payeeId: string;
  readonly payRunId?: string;
  readonly decision: PolicyDecision;
  readonly reasonCodes: readonly string[];
  readonly policyId: string;
  readonly policyVersion: number;
  readonly status: OperationStatus | "pending";
  readonly quoteId?: string;
  readonly txHash?: string;
  readonly evidence?: string;
  readonly journalEntryId?: string;
  readonly note?: string;
}

/**
 * Record what the loop did with one operation: the decision, the current
 * status, and any settlement evidence. A settled outcome also writes the
 * receipt linking the journal entry to its chain transaction, and the pay-run
 * line moves to the same status so the run summary is truthful. Later calls
 * overwrite earlier ones — an approval execution replaces the waiting state,
 * and a re-resolve repeats the same answer.
 */
export function recordOutcome(store: Store, input: OutcomeInput): void {
  const now = new Date().toISOString();
  store.operationRecords.set(input.operationId, {
    operationId: input.operationId,
    orgId: input.orgId,
    payeeId: input.payeeId,
    ...(input.payRunId ? { payRunId: input.payRunId } : {}),
    decision: input.decision,
    reasonCodes: [...input.reasonCodes],
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    status: input.status,
    ...(input.quoteId ? { quoteId: input.quoteId } : {}),
    ...(input.txHash ? { txHash: input.txHash } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.journalEntryId ? { journalEntryId: input.journalEntryId } : {}),
    ...(input.note ? { note: input.note } : {}),
    updatedAt: now,
  });
  if (input.status === "settled" && input.journalEntryId) {
    store.receipts.set(input.operationId, {
      operationId: input.operationId,
      journalEntryId: input.journalEntryId,
      ...(input.quoteId ? { quoteId: input.quoteId } : {}),
      ...(input.txHash ? { txHash: input.txHash } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      settledAt: now,
    });
  }
  for (const [runId, list] of store.payRunItems) {
    const idx = list.findIndex((i) => i.operationId === input.operationId);
    if (idx < 0) continue;
    const current = list[idx]!;
    const next = [...list];
    next[idx] = { ...current, state: input.status };
    store.payRunItems.set(runId, next);
    break;
  }
}

/** Append one event to the notification outbox. */
export function notify(
  store: Store,
  input: {
    orgId: string;
    kind: NotificationKind;
    to: string;
    refType: Notification["refType"];
    refId: string;
    message: string;
  },
): Notification {
  const note: Notification = {
    id: `ntf_${store.notifications.length + 1}`,
    orgId: input.orgId,
    kind: input.kind,
    to: input.to,
    refType: input.refType,
    refId: input.refId,
    message: input.message,
    createdAt: new Date().toISOString(),
  };
  store.notifications.push(note);
  return note;
}
