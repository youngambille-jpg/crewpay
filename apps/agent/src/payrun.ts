import type { Operation, PayRunItem, Payee, Policy } from "@crewpay/domain";
import { type DecisionResult, evaluate, type DecisionContext } from "@crewpay/policy";
import { paymentSettled, type JournalEntry } from "@crewpay/ledger";
import type { SettlementRail } from "@crewpay/rails";

export interface OperationOutcome {
  readonly operationId: string;
  readonly payeeId: string;
  readonly decision: DecisionResult;
  /** Present once a payable operation reaches a terminal state. */
  readonly settlement?: Awaited<ReturnType<SettlementRail["poll"]>>;
  readonly journal?: JournalEntry;
}

export interface RunResult {
  readonly outcomes: readonly OperationOutcome[];
  readonly settledCents: number;
  readonly awaitingApproval: readonly string[];
  readonly denied: readonly string[];
  readonly failed: readonly string[];
}

export interface RunDeps {
  readonly rail: SettlementRail;
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
    let settlement = await deps.rail.submit(operation, quote);
    while (settlement.status === "pending") {
      settlement = await deps.rail.poll(operation.id);
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
      outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision, settlement, journal });
    } else {
      failed.push(operation.id);
      outcomes.push({ operationId: operation.id, payeeId: item.payeeId, decision, settlement });
    }
  }

  return { outcomes, settledCents, awaitingApproval, denied, failed };
}
