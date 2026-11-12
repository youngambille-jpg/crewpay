import type { AgentTask, ChainAsset, Operation, Payee } from "@crewpay/domain";
import { corridor } from "@crewpay/domain";
import type { AgentQuote, Quote } from "@crewpay/rails";

/** The origin the agent-pay deposit is funded from. Agents are paid from the same treasury. */
const AGENT_PAY_ORIGIN: ChainAsset = { chain: "near", asset: "usdc" };

/**
 * Turn a task into an Operation so it can go through the ordinary policy
 * engine. Agent payments are a real payout, not a side channel, so the policy
 * must see the same shape of money it sees for a contractor: a corridor, a
 * refund destination, and a USD valuation.
 */
export function operationForTask(task: AgentTask, payee: Payee | undefined): Operation {
  const destination = payee?.destination ?? task.destination;
  return {
    id: `op_task_${task.id}`,
    orgId: task.orgId,
    type: "agent_task_payout",
    amount: { amount: task.amountOut, asset: AGENT_PAY_ORIGIN.asset },
    usdCents: task.usdCents,
    origin: AGENT_PAY_ORIGIN,
    destination,
    corridor: corridor(AGENT_PAY_ORIGIN, destination),
    recipient: payee?.address ?? task.resourceUrl,
    refundTo: "crewpay.near",
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/**
 * Adapt an x402 quote to the `Quote` the signer funds against. The two carry the
 * same facts under different names, and the signer only needs the deposit
 * address, the input amount and the deadline.
 */
export function quoteForSigner(task: AgentTask, quote: AgentQuote): Quote {
  return {
    quoteId: quote.operationToken,
    amountIn: quote.amountIn,
    minAmountIn: quote.amountIn,
    amountOut: task.amountOut,
    minAmountOut: task.amountOut,
    feeIn: 0n,
    depositAddress: quote.depositAddress,
    deadline: quote.refundDeadline,
  };
}
