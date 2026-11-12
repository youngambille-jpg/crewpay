import type { Operation } from "@crewpay/domain";
import type { DepositProof, Quote } from "@crewpay/rails";

/**
 * How the origin funds reach the rail's deposit address.
 * - `intents`: a gasless NEAR Intents withdraw that delivers the asset to the
 *   deposit address on the origin chain. Works from any chain, needs no gas.
 * - `onchain`: an on-chain NEAR transaction (native transfer or NEP-141
 *   transfer) from the custody wallet's own account.
 */
export type FundingRoute = "onchain" | "intents";

export interface FundingPlan {
  readonly route: FundingRoute;
  /** Destination chain for an intents withdraw; `near` for the on-chain route. */
  readonly chain: string;
  /** Token id in the form the chosen endpoint expects. */
  readonly token: string;
  /** Amount in the token's smallest unit, as a decimal string. */
  readonly amount: string;
  /** Deposit memo to attach when the origin chain uses one. */
  readonly memo?: string;
}

export interface SignerWallet {
  readonly walletId: string;
  readonly nearAccountId: string;
}

/**
 * The result of funding one deposit. Funding is not a boolean: a withdrawal can
 * be in flight, fail cleanly, fail with the funds in an unknown state, or need
 * a human. The caller must be able to tell those apart, because the wrong
 * choice retries a payment that may already have moved.
 */
export type FundingOutcome =
  | { readonly kind: "deposited"; readonly proof: DepositProof }
  | { readonly kind: "pending"; readonly reason: string; readonly requestId?: string }
  | { readonly kind: "failed"; readonly reason: string; readonly safeToRetry: boolean }
  | { readonly kind: "needs_review"; readonly reason: string; readonly requestId?: string };

export class SignerError extends Error {
  readonly signer: string;
  readonly statusCode: number;
  /** The service's machine-readable error code, when it gave one. */
  readonly code: string;

  constructor(signer: string, statusCode: number, code: string, message: string) {
    super(`${signer}: ${code}: ${message}`);
    this.name = "SignerError";
    this.signer = signer;
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * The custody policy surface. OutLayer's policy is authored by the wallet's
 * owner in the dashboard, not by the agent, so this is read-and-propose rather
 * than write: the compiled manifest is what we ask the owner to approve, and
 * the effective policy is what we diff against at runtime.
 */
export interface CustodyPolicy {
  /**
   * Read the policy the TEE actually enforces. This governs money, and it is
   * the owner's, so it can differ from what we proposed.
   */
  effectivePolicy(): Promise<Record<string, unknown>>;
  /**
   * Multisig approvals waiting on the wallet. A request that returned
   * `pending_approval` settles only when a human votes, so this is how such an
   * operation is found rather than polled into a false escalation.
   */
  openApprovals(): Promise<readonly { approvalId: string; requestId?: string; status?: string }[]>;
}

/**
 * A signer funds an operation's deposit and returns proof that it was
 * broadcast. It never exposes a key: signing happens inside a TEE and the
 * signer holds only an API key. `FakeSigner` is the offline implementation.
 *
 * `custody` is optional so a funding-only signer stays valid; the OutLayer
 * implementations provide it so the approvals inbox can mirror the wallet's own
 * multisig state.
 */
export interface Signer {
  readonly name: string;
  readonly wallet: SignerWallet;
  /** Decide, without side effects, how this operation's deposit will be funded. */
  plan(operation: Operation, quote: Quote): FundingPlan;
  fund(operation: Operation, quote: Quote, plan: FundingPlan): Promise<FundingOutcome>;
  readonly custody?: CustodyPolicy;
}
