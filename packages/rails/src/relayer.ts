import {
  MetaTxError,
  NonceGuard,
  decodeSignedDelegateAction,
  planRelay,
  validateDelegateAction,
  type MetaTxPolicy,
  type RelayPlan,
  type SignedDelegateAction,
} from "./metatx.ts";

/**
 * A NEP-366 relayer: the service that accepts a payee's signed delegate action,
 * checks it against the relayer's policy, and (once a broadcast-capable signer
 * exists) submits the outer transaction so the relayer pays the gas.
 *
 * Everything here is real except the broadcast. `decodeSignedDelegateAction`
 * parses the exact borsh the payee signed, `validateDelegateAction` verifies the
 * signature and the policy, and `planRelay` assembles the outer transaction. The
 * final `broadcast_tx_commit` is not performed, because OutLayer's wallet API can
 * only emit `transfer`/`ft_transfer`/`call` and cannot emit `Action::Delegate`.
 * The outcome says so in `broadcastable` and `note` — it never claims a tx hash
 * it did not produce.
 *
 * This matters for the agent-pay path: an agent paid on-chain holds no NEAR, so
 * it cannot pay gas for its own withdrawal. It signs a delegate action instead,
 * and the relayer covers the gas.
 */

/** The relayer's verdict on one submitted delegate action. */
export type RelayStatus =
  | "rejected"
  /** Passed every check and the outer tx is assembled — but not broadcast here. */
  | "planned";

export interface RelayOutcome {
  readonly status: RelayStatus;
  /** Why it was rejected, or why it was planned but not broadcast. */
  readonly reasons: readonly string[];
  readonly senderId?: string;
  readonly receiverId?: string;
  /** Nonce, as a decimal string, for the operator's audit trail. */
  readonly nonce?: string;
  readonly signedHashHex?: string;
  /** True only when the relayer actually submitted the outer transaction. */
  readonly broadcastable: boolean;
  /** Plain-language note on what did and did not happen. */
  readonly note: string;
}

const NOT_BROADCAST =
  "validated and assembled, but not broadcast: the custody wallet cannot emit Action::Delegate";

export class Relayer {
  private readonly policy: MetaTxPolicy;
  private readonly guard: NonceGuard;

  constructor(policy: MetaTxPolicy, guard: NonceGuard = new NonceGuard()) {
    this.policy = policy;
    this.guard = guard;
  }

  /**
   * Handle one base64-encoded borsh `SignedDelegateAction`. Decode, validate,
   * guard the nonce, then plan. A decode failure is a rejection, not a crash:
   * a malformed payload from a payee must not take the relayer down.
   */
  handle(encodedBase64: string): RelayOutcome {
    let signed: SignedDelegateAction;
    try {
      signed = decodeSignedDelegateAction(Buffer.from(encodedBase64, "base64"));
    } catch (err) {
      const detail = err instanceof MetaTxError ? err.message : "not valid base64 borsh";
      return {
        status: "rejected",
        reasons: [`could not decode the delegate action: ${detail}`],
        broadcastable: false,
        note: "rejected before any check",
      };
    }

    const { delegateAction } = signed;
    const validation = validateDelegateAction(signed, this.policy);
    if (!validation.ok) {
      return {
        status: "rejected",
        reasons: validation.reasons,
        senderId: delegateAction.senderId,
        receiverId: delegateAction.receiverId,
        nonce: delegateAction.nonce.toString(),
        broadcastable: false,
        note: "rejected by the relayer policy",
      };
    }

    // The signature and policy passed; only now is the nonce worth spending.
    if (!this.guard.accept(delegateAction.senderId, delegateAction.publicKey, delegateAction.nonce)) {
      return {
        status: "rejected",
        reasons: [`nonce ${delegateAction.nonce} was already used for this key`],
        senderId: delegateAction.senderId,
        receiverId: delegateAction.receiverId,
        nonce: delegateAction.nonce.toString(),
        broadcastable: false,
        note: "rejected as a replay",
      };
    }

    const plan: RelayPlan = planRelay(signed);
    return {
      status: "planned",
      reasons: [plan.reason],
      senderId: delegateAction.senderId,
      receiverId: plan.receiverId,
      nonce: delegateAction.nonce.toString(),
      signedHashHex: plan.signedHashHex,
      broadcastable: plan.broadcastable,
      note: NOT_BROADCAST,
    };
  }
}
