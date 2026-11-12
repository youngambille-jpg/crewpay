import type { Approval, Operation, PayRun, PayRunItem, Payee, Policy } from "@crewpay/domain";

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
  };
}

export function activePolicy(store: Store, orgId: string): Policy | undefined {
  for (const policy of store.policies.values()) {
    if (policy.orgId === orgId && policy.active) return policy;
  }
  return undefined;
}
