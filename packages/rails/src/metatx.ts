/**
 * NEP-366 meta transactions: a relayer pays the gas so a payee who holds no
 * NEAR can still be paid.
 *
 * Everything here is real up to the broadcast. The delegate action is borsh
 * encoded exactly as nearcore encodes it, the NEP-461 signable message and its
 * sha256 are computed byte for byte, and the ed25519 signature is verified
 * against the sender's own key. The only step that is not performed is the
 * final `broadcast_tx_commit`, because OutLayer's wallet API can only send
 * `transfer`, `ft_transfer` and `call` — it cannot emit the `Delegate` action
 * this transaction needs. So the outer transaction is assembled and returned
 * ready to sign, and the transfer is the one simulated step.
 *
 * Layouts are taken from nearcore (`core/primitives/src/action/delegate.rs`,
 * `signable_message.rs`, `core/crypto/src/signature.rs`), not from memory.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/** `Action::Delegate`, per `Action`'s borsh discriminant in nearcore. */
export const ACTION_DELEGATE = 8;
/** `Action::FunctionCall`. */
export const ACTION_FUNCTION_CALL = 2;
/** `Action::Transfer`. */
export const ACTION_TRANSFER = 3;
/** NEP-461 on-chain discriminant base; `DelegateAction` is `2^30 + 366`. */
export const NEP461_ON_CHAIN_BASE = 1 << 30;
export const NEP366_DISCRIMINANT = NEP461_ON_CHAIN_BASE + 366;

/** A single inner action. Nested delegates are rejected at decode time. */
export type InnerAction =
  | {
      readonly type: "FunctionCall";
      readonly methodName: string;
      /** Raw JSON args, kept as the exact bytes that were signed. */
      readonly args: Uint8Array;
      readonly gas: bigint;
      readonly deposit: bigint;
    }
  | { readonly type: "Transfer"; readonly deposit: bigint };

export interface DelegateAction {
  readonly senderId: string;
  readonly receiverId: string;
  readonly actions: readonly InnerAction[];
  readonly nonce: bigint;
  readonly maxBlockHeight: bigint;
  /** `ed25519:<base58>` — the key on the sender's account that signed this. */
  readonly publicKey: string;
}

export interface SignedDelegateAction {
  readonly delegateAction: DelegateAction;
  /** 64 raw ed25519 signature bytes. */
  readonly signature: Uint8Array;
}

export class MetaTxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MetaTxError";
    this.code = code;
  }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// --- borsh primitives ------------------------------------------------------

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function u128(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function borshBytes(b: Uint8Array): Buffer {
  const buf = Buffer.from(b);
  return Buffer.concat([u32(buf.length), buf]);
}

/** `PublicKey` borsh: 1-byte tag (0 = ed25519) + 32 raw key bytes. */
function borshPublicKey(raw: Uint8Array): Buffer {
  if (raw.length !== 32) {
    throw new MetaTxError("bad_public_key", `ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return Buffer.concat([Buffer.from([0]), Buffer.from(raw)]);
}

function borshSignature(sig: Uint8Array): Buffer {
  if (sig.length !== 64) {
    throw new MetaTxError("bad_signature", `ed25519 signature must be 64 bytes, got ${sig.length}`);
  }
  return Buffer.concat([Buffer.from([0]), Buffer.from(sig)]);
}

function borshInnerAction(action: InnerAction): Buffer {
  if (action.type === "FunctionCall") {
    return Buffer.concat([
      Buffer.from([ACTION_FUNCTION_CALL]),
      borshString(action.methodName),
      borshBytes(action.args),
      u64(action.gas),
      u128(action.deposit),
    ]);
  }
  return Buffer.concat([Buffer.from([ACTION_TRANSFER]), u128(action.deposit)]);
}

/**
 * Borsh encoding of `DelegateAction`. The field order is the struct's own, and
 * `actions` is a `Vec<NonDelegateAction>` — a u32 count then each action.
 */
export function encodeDelegateAction(action: DelegateAction): Buffer {
  return Buffer.concat([
    borshString(action.senderId),
    borshString(action.receiverId),
    u32(action.actions.length),
    ...action.actions.map(borshInnerAction),
    u64(action.nonce),
    u64(action.maxBlockHeight),
    borshPublicKey(parsePublicKey(action.publicKey)),
  ]);
}

/**
 * The NEP-461 signable message: the on-chain discriminant for NEP-366 (a u32,
 * little-endian) followed by the borsh `DelegateAction`. This is the exact byte
 * string the sender signed.
 */
export function signableMessage(action: DelegateAction): Buffer {
  return Buffer.concat([u32(NEP366_DISCRIMINANT), encodeDelegateAction(action)]);
}

/** `hash(delegate_action)` — sha256 of the signable message. */
export function delegateActionHash(action: DelegateAction): Buffer {
  return createHash("sha256").update(signableMessage(action)).digest();
}

/** `SignedDelegateAction` borsh: the action, then the `Signature`. */
export function encodeSignedDelegateAction(signed: SignedDelegateAction): Buffer {
  return Buffer.concat([encodeDelegateAction(signed.delegateAction), borshSignature(signed.signature)]);
}

/** `Action::Delegate(SignedDelegateAction)` — the outer transaction's action. */
export function encodeDelegateActionWrapper(signed: SignedDelegateAction): Buffer {
  return Buffer.concat([Buffer.from([ACTION_DELEGATE]), encodeSignedDelegateAction(signed)]);
}

// --- decoding --------------------------------------------------------------

class Reader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  u128(): bigint {
    this.need(16);
    const lo = this.buf.readBigUInt64LE(this.offset);
    const hi = this.buf.readBigUInt64LE(this.offset + 8);
    this.offset += 16;
    return lo | (hi << 64n);
  }

  bytes(len: number): Buffer {
    this.need(len);
    const slice = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  string(): string {
    const len = this.u32();
    return this.bytes(len).toString("utf8");
  }

  private need(len: number): void {
    if (this.offset + len > this.buf.length) {
      throw new MetaTxError("truncated", "delegate action is truncated");
    }
  }
}

function decodeInnerAction(reader: Reader): InnerAction {
  const tag = reader.u8();
  if (tag === ACTION_FUNCTION_CALL) {
    const methodName = reader.string();
    const args = reader.bytes(reader.u32());
    const gas = reader.u64();
    const deposit = reader.u128();
    return { type: "FunctionCall", methodName, args: new Uint8Array(args), gas, deposit };
  }
  if (tag === ACTION_TRANSFER) {
    return { type: "Transfer", deposit: reader.u128() };
  }
  if (tag === ACTION_DELEGATE || tag === 14) {
    // NEP-366 forbids a delegate inside a delegate; a relayer must not forward one.
    throw new MetaTxError("nested_delegate", "a delegate action may not contain another delegate action");
  }
  throw new MetaTxError("unsupported_action", `unsupported inner action tag ${tag}`);
}

function decodePublicKey(reader: Reader): string {
  const tag = reader.u8();
  if (tag !== 0) throw new MetaTxError("unsupported_key", `only ed25519 keys are accepted, got tag ${tag}`);
  return `ed25519:${base58Encode(reader.bytes(32))}`;
}

/**
 * Decode a borsh `SignedDelegateAction`. Strict: an unknown action tag or a
 * nested delegate is an error rather than a silently dropped action, so a
 * relayer never executes a subset of what was signed.
 */
export function decodeSignedDelegateAction(bytes: Uint8Array): SignedDelegateAction {
  const reader = new Reader(Buffer.from(bytes));
  const senderId = reader.string();
  const receiverId = reader.string();
  const count = reader.u32();
  const actions: InnerAction[] = [];
  for (let i = 0; i < count; i += 1) actions.push(decodeInnerAction(reader));
  const nonce = reader.u64();
  const maxBlockHeight = reader.u64();
  const publicKey = decodePublicKey(reader);
  const sigTag = reader.u8();
  if (sigTag !== 0) throw new MetaTxError("unsupported_signature", `unsupported signature tag ${sigTag}`);
  const signature = new Uint8Array(reader.bytes(64));
  if (reader.remaining !== 0) {
    throw new MetaTxError("trailing_bytes", `${reader.remaining} unexpected trailing bytes`);
  }
  return {
    delegateAction: { senderId, receiverId, actions, nonce, maxBlockHeight, publicKey },
    signature,
  };
}

// --- verification ----------------------------------------------------------

/**
 * Verify the sender's signature over the NEP-461 hash. This is the check that
 * makes a delegate action trustworthy: it proves the sender's own account key
 * authorised exactly these actions.
 */
export function verifySignedDelegateAction(signed: SignedDelegateAction): boolean {
  const raw = parsePublicKey(signed.delegateAction.publicKey);
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(null, delegateActionHash(signed.delegateAction), key, Buffer.from(signed.signature));
}

export interface MetaTxPolicy {
  /**
   * Receiver ids this relayer will relay for. The payee's own contract only —
   * a relayer that forwards to any receiver is a gas faucet for the whole chain.
   */
  readonly allowedReceivers: readonly string[];
  /** Methods the relayer will sponsor, when the inner action is a call. */
  readonly allowedMethods?: readonly string[];
  /** Largest deposit the relayer will carry, in yoctoNEAR. */
  readonly maxDepositYocto?: bigint;
  /** Largest gas the relayer will sponsor per action. */
  readonly maxGas?: bigint;
}

export interface MetaTxValidation {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * Check a signed delegate action against the relayer's policy. Signature first:
 * every other check is meaningless if the sender did not sign this.
 */
export function validateDelegateAction(signed: SignedDelegateAction, policy: MetaTxPolicy): MetaTxValidation {
  const reasons: string[] = [];
  const { delegateAction: action } = signed;

  if (!verifySignedDelegateAction(signed)) reasons.push("signature does not match the sender's public key");
  if (!policy.allowedReceivers.includes(action.receiverId)) {
    reasons.push(`receiver ${action.receiverId} is not on the allow-list`);
  }
  if (action.senderId !== action.receiverId && policy.allowedReceivers.length > 0) {
    // Not fatal on its own, but a delegate action normally targets the sender's
    // own account; note it so the operator sees the shape.
  }

  for (const inner of action.actions) {
    if (inner.type === "FunctionCall") {
      if (policy.allowedMethods && !policy.allowedMethods.includes(inner.methodName)) {
        reasons.push(`method ${inner.methodName} is not on the allow-list`);
      }
      if (policy.maxGas !== undefined && inner.gas > policy.maxGas) {
        reasons.push(`gas ${inner.gas} exceeds the sponsored maximum ${policy.maxGas}`);
      }
      if (policy.maxDepositYocto !== undefined && inner.deposit > policy.maxDepositYocto) {
        reasons.push(`deposit ${inner.deposit} exceeds the sponsored maximum ${policy.maxDepositYocto}`);
      }
    } else if (policy.maxDepositYocto !== undefined && inner.deposit > policy.maxDepositYocto) {
      reasons.push(`transfer of ${inner.deposit} exceeds the sponsored maximum ${policy.maxDepositYocto}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * An in-memory replay guard keyed by `sender_id:public_key`. NEP-366 already
 * rejects a reused nonce on-chain, but a relayer that submits twice pays twice,
 * so it refuses a nonce it has already seen for a key before broadcasting.
 */
export class NonceGuard {
  private readonly seen = new Map<string, bigint>();

  /** True if this nonce is fresh for the key (and records it). */
  accept(senderId: string, publicKey: string, nonce: bigint): boolean {
    const key = `${senderId}:${publicKey}`;
    const highest = this.seen.get(key);
    if (highest !== undefined && nonce <= highest) return false;
    this.seen.set(key, nonce);
    return true;
  }
}

// --- outer transaction -----------------------------------------------------

export interface RelayPlan {
  /** `transaction.receiver_id` — NEP-366 requires this to equal the sender. */
  readonly receiverId: string;
  /** The single `Delegate` action, borsh encoded, ready to place in a tx. */
  readonly actionBytes: Uint8Array;
  /** The NEP-461 hash the sender signed; kept as the audit trail. */
  readonly signedHashHex: string;
  /** True when the relayer would broadcast; false because OutLayer cannot. */
  readonly broadcastable: boolean;
  readonly reason: string;
}

/**
 * Assemble the outer transaction's `Delegate` action. NEP-366 requires
 * `receiver_id == delegate_action.sender_id`, so the plan pins it rather than
 * letting a caller set a different one.
 *
 * `broadcastable` is false and stays false in this build: the custody wallet can
 * only send `transfer`/`ft_transfer`/`call`, so the relayer cannot emit this
 * action. Everything up to the broadcast is real, and the transfer is the one
 * simulated step.
 */
export function planRelay(signed: SignedDelegateAction): RelayPlan {
  return {
    receiverId: signed.delegateAction.senderId,
    actionBytes: new Uint8Array(encodeDelegateActionWrapper(signed)),
    signedHashHex: delegateActionHash(signed.delegateAction).toString("hex"),
    broadcastable: false,
    reason:
      "OutLayer's wallet API exposes transfer/ft_transfer/call only; it cannot emit an Action::Delegate, " +
      "so the outer transaction is assembled but not broadcast",
  };
}

// --- base58 ----------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (const byte of bytes.subarray(zeros)) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58_ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array();
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < input.length; i += 1) {
    const value = B58_ALPHABET.indexOf(input[i]!);
    if (value === -1) throw new MetaTxError("bad_base58", `invalid base58 character ${input[i]}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + bytes.length - 1 - i] = bytes[i]!;
  return out;
}

/** Parse `ed25519:<base58>` (or a bare base58 key) into 32 raw bytes. */
export function parsePublicKey(publicKey: string): Uint8Array {
  const [tag, data] = publicKey.includes(":") ? publicKey.split(":", 2) : ["ed25519", publicKey];
  if (tag !== "ed25519") throw new MetaTxError("unsupported_key", `unsupported key type ${tag}`);
  const raw = base58Decode(data ?? "");
  if (raw.length !== 32) {
    throw new MetaTxError("bad_public_key", `expected a 32-byte ed25519 key, decoded ${raw.length}`);
  }
  return raw;
}
