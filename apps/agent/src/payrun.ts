import type { Operation, PayRunItem, Payee, Policy } from "@crewpay/domain";
import { type DecisionResult, evaluate, type DecisionContext } from "@crewpay/policy";
import { paymentSettled, type JournalEntry } from "@crewpay/ledger";
import type { SettlementRail, DepositProof, SettlementStatus } from "@crewpay/rails";
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
  readonly settlement?: Awaited<ReturnType<SettlementRail["poll"]>>;
  /** How funding went, when the operation got as far as the signer. */
  readonly funding?: FundingOutcome;
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
  let spentTodayCents = 0;
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

    const quote = await deps.rail.quote(operation);

    // Fund the deposit before telling the rail it was funded. A funding outcome
    // that is not "deposited" must stop here: retrying an unknown-state funding
    // can move funds twice, so it is escalated rather than retried.
    let proof: DepositProof | undefined;
    let funded: FundingOutcome | undefined;
    if (deps.signer) {
      const plan = deps.signer.plan(operation, quote);
      const funding = await deps.signer.fund(operation, quote, plan);
      if (funding.kind === "needs_review") {
        needsReview.push(operation.id);
        outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision, funding });
        continue;
      }
      if (funding.kind === "pending") {
        // In flight, not failed: leave it unsettled and let a later run or the
        // approvals inbox resolve it rather than reporting a false failure.
        needsReview.push(operation.id);
        outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision, funding });
        continue;
      }
      if (funding.kind === "failed") {
        failed.push(operation.id);
        outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision, funding });
        continue;
      }
      proof = funding.proof;
      funded = funding;
    }

    let settlement = await deps.rail.submit(operation, quote, proof);
    for (let attempt = 0; attempt < MAX_POLLS && isInFlight(settlement.status); attempt += 1) {
      settlement = await deps.rail.poll(operation.id, quote);
    }

    if (settlement.status === "settled") {
      spentTodayCents += operation.usdCents;
      settledCents += operation.usdCents;
      const journal = paymentSettled({
        id: `je_${operation.id}`,
        orgId,
        amount: quote.amountOut,
        fee: quote.feeIn,
        currency: operation.destination.asset,
        memo: `${operation.type} ${operation.id} settled`,
      });
      outcomes.push({
        operationId: operation.id,
        payeeId: item.payeeId,
        decision,
        settlement,
        journal,
        ...(funded ? { funding: funded } : {}),
      });
    } else if (settlement.status === "failed" || settlement.status === "refunded") {
      failed.push(operation.id);
      outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision, settlement });
    } else {
      // Still in flight after the poll budget: not a failure, needs attention.
      needsReview.push(operation.id);
      outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision, settlement });
    }
  }

  return { outcomes, settledCents, awaitingApproval, denied, failed, needsReview };
}
