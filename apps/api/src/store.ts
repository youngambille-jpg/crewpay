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
  };
}

export function activePolicy(store: Store, orgId: string): Policy | undefined {
  for (const policy of store.policies.values()) {
    if (policy.orgId === orgId && policy.active) return policy;
  }
  return undefined;
}
