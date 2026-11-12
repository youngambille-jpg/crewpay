import type { ChainAsset, UsdCents } from "./money.ts";

/**
 * Which agent-payment protocol carries the task. `x402` is the HTTP 402
 * challenge/quote/deposit flow (x402 v2, scheme `exact`, `near-intents`,
 * upfront); `mpp` is the MPP charge endpoint. They share the payee metadata and
 * the NEAR Intents settlement backend, and many teams run one per surface.
 */
export type AgentProtocol = "x402" | "mpp";

export type AgentTaskStatus =
  | "open"
  /** A quote is live: a deposit address exists and has a deadline. */
  | "quoted"
  /** Policy held the payout back; a human must approve it. */
  | "awaiting_approval"
  | "paid"
  /** Deposit seen, settlement not terminal yet. Retry the same token. */
  | "pending"
  /** Deposit was short. Top up the same address and retry the same token. */
  | "incomplete"
  /** Funds may have moved and the state is not knowable from here. */
  | "needs_review"
  | "failed";

/**
 * Terminal proof that an agent was paid. `operationToken` is the idempotency
 * handle: a fully consumed challenge re-posted with the same proof returns this
 * same receipt rather than paying again.
 */
export interface PayoutReceipt {
  readonly operationToken: string;
  readonly depositAddress: string;
  /** Origin base units delivered. This is a *minimum*; short delivery is incomplete. */
  readonly amountIn: bigint;
  /** Origin-chain deposit transaction. */
  readonly txHash: string;
  /**
   * Where settlement landed. `near:mainnet` when the payee uses Intents
   * settlement; otherwise the destination CAIP-2 network.
   */
  readonly network: string;
  readonly settledAt: string;
}

/**
 * One unit of work an agent performed and is owed for. It is deliberately
 * separate from the Operation it produces: a task is the claim ("this agent
 * served this resource"), and paying it is a policy-checked money movement.
 */
export interface AgentTask {
  readonly id: string;
  readonly orgId: string;
  readonly payeeId: string;
  readonly protocol: AgentProtocol;
  /** The x402-protected resource the agent served, or the MPP charge target. */
  readonly resourceUrl: string;
  /** What the agent must receive, in destination base units. */
  readonly amountOut: bigint;
  /** Valuation at creation, for policy. */
  readonly usdCents: UsdCents;
  readonly destination: ChainAsset;
  readonly description?: string;
  /** The caller's own correlation id, passed through to the facilitator. */
  readonly externalId?: string;
  readonly status: AgentTaskStatus;
  readonly createdAt: string;
  readonly receipt?: PayoutReceipt;
  /** Why it failed, or what a human must resolve. */
  readonly note?: string;
}
