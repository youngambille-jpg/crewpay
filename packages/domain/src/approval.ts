import type { Operation } from "./operation.ts";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed"
  | "stale";

/**
 * A human decision that a specific operation may proceed.
 *
 * The operation is frozen at request time and never re-derived from live
 * state. That matters for two reasons: an approver must be signing off on the
 * exact amount, recipient and corridor they were shown, and a later change to
 * a pay run cannot silently widen what was authorised.
 *
 * `policyId`/`policyVersion` record which rules produced the request, so the
 * audit trail shows the rules in force at decision time. They are not
 * permission to execute: approval clears the human gate only, and execution
 * re-checks the *current* policy.
 */
export interface Approval {
  readonly id: string;
  readonly orgId: string;
  readonly operationId: string;
  /** The frozen operation, as approved. */
  readonly operation: Operation;
  readonly payeeId: string;
  /** Which policy produced the request. */
  readonly policyId: string;
  readonly policyVersion: number;
  /** Machine-readable reason codes that required approval. */
  readonly reasonCodes: readonly string[];
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  /** Set when a rejection explains itself, or when execution fails. */
  readonly note?: string;
}

/**
 * True when an approval can still be acted on. `executed`, `rejected` and
 * `stale` are final: acting on one again is a bug, not a retry.
 */
export function isOpen(approval: Approval): boolean {
  return approval.status === "pending" || approval.status === "approved";
}
