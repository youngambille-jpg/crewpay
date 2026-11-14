import type { Approval, Operation, PayRunItem, Payee, Policy } from "@crewpay/domain";
import { type DecisionResult, evaluate, type DecisionContext } from "@crewpay/policy";
import { paymentSettled, type JournalEntry } from "@crewpay/ledger";
import type { SettlementRail, DepositProof, Quote, SettlementStatus, SettlementResult } from "@crewpay/rails";
import type { FundingOutcome, Signer } from "@crewpay/signer";

/** How many times to poll a rail before giving up on an in-flight settlement. */
const MAX_POLLS = 30;

/** States that mean "not finished yet"; the rail should be polled again. */
function isInFlight(status: SettlementStatus): boolean {
  return status === "quoted" || status === "submitted" || status === "pending";
}

export interface OperationOutcome {
  readonly operationId: string;
  readonly payeeId: string;
  readonly decision: DecisionResult;
  /** Present once a payable operation reaches a terminal state. */
  readonly settlement?: SettlementResult;
  /** How funding went, when the operation got as far as the signer. */
  readonly funding?: FundingOutcome;
  /**
   * The rail quote for this operation's deposit. Kept beside an unresolved
   * funding so its deposit address is available to re-read the settlement.
   */
  readonly quote?: Quote;
  readonly journal?: JournalEntry;
}

export interface RunResult {
  readonly outcomes: readonly OperationOutcome[];
  readonly settledCents: number;
  readonly awaitingApproval: readonly string[];
  readonly denied: readonly string[];
  readonly failed: readonly string[];
  /** Operations whose funds are in an unknown state and need a human. */
  readonly needsReview: readonly string[];
}

export interface RunDeps {
  readonly rail: SettlementRail;
  /** Funds the rail's deposit address. Optional: without it the rail is unfunded. */
  readonly signer?: Signer;
  /** Resolves the payee for a run item, if any. */
  readonly lookupPayee: (payeeId: string) => Payee | undefined;
  /** True if the payee has at least one previously settled payment. */
  readonly payeeHasHistory: (payeeId: string) => boolean;
  /**
   * USD cents already settled today before this run. Seeds the daily cap so it
   * holds across runs, not just within one.
   */
  readonly spentTodayCents?: number;
}

/**
 * How one operation ended, independent of why it was authorised. `settled`
 * carries the journal entry; the rest say what a caller must do next. The
 * funding detail travels with every variant so the caller can record the
 * deposit proof, or the reason funding did not complete.
 *
 * `quote` travels too, and it is not decoration: the deposit address inside it
 * is the only key the rail answers a settlement status for. An unresolved
 * funding keeps the request id; without the quote beside it we could later
 * confirm the deposit landed but never learn whether the payee was paid.
 */
export type SettlementOutcome =
  | {
      readonly kind: "settled";
      readonly settlement: SettlementResult;
      readonly journal: JournalEntry;
      readonly funding?: FundingOutcome;
      readonly quote?: Quote;
    }
  | {
      readonly kind: "failed";
      readonly settlement?: SettlementResult;
      readonly funding?: FundingOutcome;
      readonly quote?: Quote;
    }
  | {
      readonly kind: "needs_review";
      readonly settlement?: SettlementResult;
      readonly funding?: FundingOutcome;
      readonly quote?: Quote;
    };

/**
 * Move one already-authorised operation: quote, fund the deposit, submit, then
 * poll to a terminal state. This is the only place money moves, so both the pay
 * run and an approved operation go through it and cannot drift apart.
 *
 * Funding is checked before submit because a funding outcome that is not
 * `deposited` must stop here: retrying unknown-state funding can move funds
 * twice.
 */
export async function settleOperation(
  orgId: string,
  operation: Operation,
  deps: Pick<RunDeps, "rail" | "signer">,
): Promise<SettlementOutcome> {
  // Refuse an unreachable corridor before quoting or funding. A rail that only
  // reaches part of the corridor says so here, and stopping now is what keeps
  // an uncompletable payment from leaving an orphaned deposit on-chain.
  const preflight = deps.rail.preflight?.(operation);
  if (preflight && !preflight.ok) {
    return {
      kind: "failed",
      settlement: { operationId: operation.id, status: "failed", failureReason: preflight.reason },
    };
  }

  const quote = await deps.rail.quote(operation);

  let proof: DepositProof | undefined;
  let funded: FundingOutcome | undefined;
  if (deps.signer) {
    const plan = deps.signer.plan(operation, quote);
    const funding = await deps.signer.fund(operation, quote, plan);
    if (funding.kind === "needs_review" || funding.kind === "pending") {
      return { kind: "needs_review", funding, quote };
    }
    if (funding.kind === "failed") {
      return { kind: "failed", funding, quote };
    }
    proof = funding.proof;
    funded = funding;
  }

  let settlement = await deps.rail.submit(operation, quote, proof);
  for (let attempt = 0; attempt < MAX_POLLS && isInFlight(settlement.status); attempt += 1) {
    settlement = await deps.rail.poll(operation.id, quote);
  }

  if (settlement.status === "settled") {
    const journal = paymentSettled({
      id: `je_${operation.id}`,
      orgId,
      amount: quote.amountOut,
      fee: quote.feeIn,
      currency: operation.destination.asset,
      memo: `${operation.type} ${operation.id} settled`,
    });
    return { kind: "settled", settlement, journal, quote, ...(funded ? { funding: funded } : {}) };
  }

  if (settlement.status === "failed" || settlement.status === "refunded") {
    return { kind: "failed", settlement, quote, ...(funded ? { funding: funded } : {}) };
  }

  // Still in flight after the poll budget: not a failure, needs attention.
  return { kind: "needs_review", settlement, quote, ...(funded ? { funding: funded } : {}) };
}

/**
 * Executes a pay run: evaluate each operation against policy, settle the
 * allowed ones through the rail, and record a journal entry per settlement.
 * Operations that require approval are returned for the approvals inbox rather
 * than executed. Nothing here knows about 1Click, OutLayer or PingPay — those
 * live behind `SettlementRail` and the signer.
 */
export async function executeRun(
  orgId: string,
  policy: Policy,
  items: readonly { item: PayRunItem; operation: Operation }[],
  deps: RunDeps,
  hour = 12,
): Promise<RunResult> {
  const outcomes: OperationOutcome[] = [];
  const awaitingApproval: string[] = [];
  const denied: string[] = [];
  const failed: string[] = [];
  const needsReview: string[] = [];
  let spentTodayCents = deps.spentTodayCents ?? 0;
  let settledCents = 0;

  for (const { item, operation } of items) {
    const payee = deps.lookupPayee(item.payeeId);
    const ctx: DecisionContext = {
      payee,
      spentTodayCents,
      payeeHasHistory: deps.payeeHasHistory(item.payeeId),
      hour,
    };
    const decision = evaluate(operation, policy, ctx);

    if (decision.decision === "deny") {
      denied.push(operation.id);
      outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision });
      continue;
    }

    if (decision.decision === "allow_with_approval") {
      awaitingApproval.push(operation.id);
      outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision });
      continue;
    }

    const result = await settleOperation(orgId, operation, deps);
    if (result.kind === "settled") {
      spentTodayCents += operation.usdCents;
      settledCents += operation.usdCents;
      outcomes.push({
        operationId: operation.id,
        payeeId: item.payeeId,
        decision,
        settlement: result.settlement,
        journal: result.journal,
        ...(result.funding ? { funding: result.funding } : {}),
        ...(result.quote ? { quote: result.quote } : {}),
      });
    } else if (result.kind === "failed") {
      failed.push(operation.id);
      outcomes.push({
        operationId: operation.id,
        payeeId: item.payeeId,
        decision,
        ...(result.settlement ? { settlement: result.settlement } : {}),
        ...(result.funding ? { funding: result.funding } : {}),
        ...(result.quote ? { quote: result.quote } : {}),
      });
    } else {
      needsReview.push(operation.id);
      outcomes.push({
        operationId: operation.id,
        payeeId: item.payeeId,
        decision,
        ...(result.settlement ? { settlement: result.settlement } : {}),
        ...(result.funding ? { funding: result.funding } : {}),
        ...(result.quote ? { quote: result.quote } : {}),
      });
    }
  }

  return { outcomes, settledCents, awaitingApproval, denied, failed, needsReview };
}

export interface ExecuteApprovedDeps extends Pick<RunDeps, "rail" | "signer" | "lookupPayee" | "payeeHasHistory"> {
  /** The policy currently in force for the org. */
  readonly policy: Policy;
  /** USD cents already committed today, for the daily cap. */
  readonly spentTodayCents?: number;
  readonly hour?: number;
}

export interface ExecuteApprovedResult {
  readonly status: "executed" | "failed" | "needs_review" | "stale";
  readonly approval: Approval;
  readonly journal?: JournalEntry;
  /** The rail's terminal answer, with the tx evidence the receipt needs. */
  readonly settlement?: SettlementResult;
  readonly reasons?: readonly string[];
  /**
   * How funding went. Carried on every terminal outcome so the caller can keep
   * the request id: an unresolved funding request is the one handle needed to
   * learn later whether the money moved.
   */
  readonly funding?: FundingOutcome;
  /** The rail quote for the deposit; the key for a later settlement re-read. */
  readonly quote?: Quote;
}

/**
 * Execute an approved operation. The human gate is already cleared, so this
 * does not ask for approval again — but it does re-run the policy engine,
 * because an approval authorises a payment, not a bypass.
 *
 * Two things can have changed since the request: the operation's payee (now
 * blocked, or re-screened as a hit) and the policy itself (a lowered cap, or a
 * corridor removed). Either turns the approval `stale` rather than paying,
 * because the approver agreed to different terms than the ones now in force.
 */
export async function executeApproved(
  approval: Approval,
  deps: ExecuteApprovedDeps,
): Promise<ExecuteApprovedResult> {
  const { operation } = approval;
  const payee = deps.lookupPayee(approval.payeeId);
  const decision = evaluate(operation, deps.policy, {
    payee,
    spentTodayCents: deps.spentTodayCents ?? 0,
    payeeHasHistory: deps.payeeHasHistory(approval.payeeId),
    hour: deps.hour ?? 12,
  });

  if (decision.decision === "deny") {
    return {
      status: "stale",
      approval: { ...approval, status: "stale", note: "policy now denies this operation" },
      reasons: decision.reasons.map((r) => r.code),
    };
  }

  const result = await settleOperation(approval.orgId, operation, deps);
  if (result.kind === "settled") {
    return {
      status: "executed",
      approval: { ...approval, status: "executed" },
      journal: result.journal,
      settlement: result.settlement,
      ...(result.funding ? { funding: result.funding } : {}),
      ...(result.quote ? { quote: result.quote } : {}),
    };
  }
  if (result.kind === "failed") {
    return {
      status: "failed",
      approval: {
        ...approval,
        status: "failed",
        ...(result.funding && result.funding.kind === "failed" ? { note: result.funding.reason } : {}),
        ...(result.settlement?.failureReason ? { note: result.settlement.failureReason } : {}),
      },
      ...(result.settlement ? { settlement: result.settlement } : {}),
      ...(result.funding ? { funding: result.funding } : {}),
      ...(result.quote ? { quote: result.quote } : {}),
    };
  }
  return {
    status: "needs_review",
    approval: { ...approval, status: "executing" },
    ...(result.settlement ? { settlement: result.settlement } : {}),
    ...(result.funding ? { funding: result.funding } : {}),
    ...(result.quote ? { quote: result.quote } : {}),
  };
}
