import type { AgentTask, PayoutReceipt, Payee } from "@crewpay/domain";
import { evaluate, type DecisionResult } from "@crewpay/policy";
import { paymentSettled, type JournalEntry } from "@crewpay/ledger";
import type { AgentPayPort, AgentQuote } from "@crewpay/rails";
import type { FundingOutcome, Signer } from "@crewpay/signer";
import { operationForTask, quoteForSigner } from "./task.ts";

/** How many times to re-settle a pending or incomplete deposit before escalating. */
const MAX_SETTLE_ATTEMPTS = 5;

export interface PayAgentTaskDeps {
  readonly agentpay: AgentPayPort;
  /** Funds the quoted deposit address. Without it, the deposit is unfunded. */
  readonly signer?: Signer;
  readonly lookupPayee: (payeeId: string) => Payee | undefined;
  readonly payeeHasHistory: (payeeId: string) => boolean;
  readonly spentTodayCents?: number;
  readonly hour?: number;
  /** Sleep between settle retries; injected so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type AgentTaskOutcome =
  | {
      readonly status: "paid";
      readonly receipt: PayoutReceipt;
      readonly journal: JournalEntry;
      readonly decision: DecisionResult;
      readonly funding?: FundingOutcome;
    }
  | { readonly status: "denied"; readonly decision: DecisionResult }
  | { readonly status: "awaiting_approval"; readonly decision: DecisionResult }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly decision?: DecisionResult;
      /** Carried so the caller keeps the request id for reconciliation. */
      readonly funding?: FundingOutcome;
    }
  /** Money may have moved and the state is not knowable from here. */
  | {
      readonly status: "needs_review";
      readonly reason: string;
      readonly decision?: DecisionResult;
      readonly funding?: FundingOutcome;
    };

/**
 * Pay an agent for one completed task.
 *
 * The task is turned into an ordinary Operation first, so it goes through the
 * *same* policy engine as a payroll line: an agent payee over its per-kind cap
 * is denied here exactly as it would be in a pay run. Agent payments are not a
 * second, softer path to money.
 *
 * Settlement reuses one operation token across retries. That is the whole
 * subtlety of the x402 flow: `pending` and `INCOMPLETE_DEPOSIT` both mean the
 * deposit exists and must be topped up or waited on, so re-quoting would
 * abandon funds already on their way and pay twice.
 */
export async function payAgentTask(
  task: AgentTask,
  policy: import("@crewpay/domain").Policy,
  deps: PayAgentTaskDeps,
): Promise<AgentTaskOutcome> {
  const payee = deps.lookupPayee(task.payeeId);
  const operation = operationForTask(task, payee);

  const decision = evaluate(operation, policy, {
    payee,
    spentTodayCents: deps.spentTodayCents ?? 0,
    payeeHasHistory: deps.payeeHasHistory(task.payeeId),
    hour: deps.hour ?? 12,
  });

  if (decision.decision === "deny") return { status: "denied", decision };
  if (decision.decision === "allow_with_approval") return { status: "awaiting_approval", decision };

  // Ask for the origin assets, then pin one with a quote. `refundTo` comes from
  // the operation, which is where the org's refund policy already lives.
  let quote: AgentQuote;
  try {
    const offers = await deps.agentpay.offers({
      amountOut: task.amountOut,
      ...(task.description ? { description: task.description } : {}),
    });
    const offer = offers.accepts[0];
    if (!offer) return { status: "failed", reason: "facilitator advertised no origin assets", decision };
    quote = await deps.agentpay.quote({ offer, refundTo: operation.refundTo });
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : "quote failed", decision };
  }

  let funding: FundingOutcome | undefined;
  if (deps.signer) {
    const signerQuote = quoteForSigner(task, quote);
    const plan = deps.signer.plan(operation, signerQuote);
    const outcome = await deps.signer.fund(operation, signerQuote, plan);
    if (outcome.kind === "needs_review" || outcome.kind === "pending") {
      return { status: "needs_review", reason: outcome.reason, decision, funding: outcome };
    }
    if (outcome.kind === "failed") {
      return { status: "failed", reason: outcome.reason, decision, funding: outcome };
    }
    funding = outcome;
  }

  const txHash = funding?.kind === "deposited" ? funding.proof.txHash : `unfunded_${quote.operationToken}`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastIncomplete: { reason: string; depositAddress: string } | undefined;

  for (let attempt = 0; attempt < MAX_SETTLE_ATTEMPTS; attempt += 1) {
    const result = await deps.agentpay.settle({ quote, txHash });
    if (result.status === "settled") {
      const journal = paymentSettled({
        id: `je_${task.id}`,
        orgId: task.orgId,
        amount: result.receipt.amountIn,
        currency: task.destination.asset,
        memo: `agent_task_payout ${task.id} settled`,
      });
      return { status: "paid", receipt: result.receipt, journal, decision, ...(funding ? { funding } : {}) };
    }
    if (result.status === "failed") {
      // A retryable failure is worth another attempt; a terminal one is not,
      // and blind-retrying a terminal failure is how a refund gets missed.
      if (result.retryable && attempt < MAX_SETTLE_ATTEMPTS - 1) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      return { status: "failed", reason: result.reason, decision };
    }
    if (result.status === "incomplete") {
      // The deposit landed short. Ping keeps the challenge active, so the token
      // is still good and retrying is safe — no new money moves. But the
      // documented remedy is to *top the deposit up*, and the shortfall is not
      // in the response, so a retry alone cannot clear a genuinely short
      // deposit. We retry anyway in case the remainder is still in flight, then
      // escalate with the address and token needed to finish it by hand.
      lastIncomplete = { reason: result.reason, depositAddress: result.depositAddress };
      await sleep(250 * (attempt + 1));
      continue;
    }
    // pending: same token, backoff.
    const delay = (result.retryAfterSeconds ?? 1) * 1000;
    await sleep(delay);
  }

  if (lastIncomplete) {
    return {
      status: "needs_review",
      reason:
        `deposit short (INCOMPLETE_DEPOSIT) at ${lastIncomplete.depositAddress}; ` +
        `top it up and retry settle with the same operation token (${quote.operationToken})`,
      decision,
    };
  }

  return {
    status: "needs_review",
    reason: "settlement did not reach a terminal state within the attempt budget",
    decision,
  };
}
