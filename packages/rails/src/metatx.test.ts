import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  MetaTxError,
  NonceGuard,
  base58Decode,
  decodeSignedDelegateAction,
  delegateActionHash,
  encodeDelegateAction,
  encodeDelegateActionWrapper,
  parsePublicKey,
  planRelay,
  signableMessage,
  validateDelegateAction,
  verifySignedDelegateAction,
  type DelegateAction,
  type InnerAction,
} from "./metatx.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The canonical delegate action near-js produced as the golden vector. */
const GOLDEN: DelegateAction = {
  senderId: "bob.testnet",
  receiverId: "bob.testnet",
  actions: [{ type: "Transfer", deposit: 1_000_000n }],
  nonce: 1n,
  maxBlockHeight: 999n,
  publicKey: "ed25519:7GPUX7S87R2sDKGnYTuQ67pvXUp8wknP3bzDoGN9H93L",
};
const GOLDEN_SIGNATURE_HEX =
  "226c6081400763e2987ea3bfcbd4069be6d9032518ddd0c09b1fd98c579fe8fd" +
  "04214b17a300b566821abd140857e70782ee787e28e94b9fbee6095de3e05908";
const GOLDEN_DELEGATE_HEX =
  "6e0100400b000000626f622e746573746e65740b000000626f622e746573746e657401000000" +
  "0340420f000000000000000000000000000100000000000000e703000000000000005d173ee3" +
  "56aed095516d6c8ea68d1dd4ef28502a17b6d6bcdebd0d5c6779c987";

function signedBytes(): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      encodeDelegateAction(GOLDEN),
      Buffer.from([0]),
      Buffer.from(GOLDEN_SIGNATURE_HEX, "hex"),
    ]),
  );
}

/** A fresh keypair whose private half we can sign with in the test. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = der.subarray(der.length - 32);
  return { raw, privateKey, publicKey };
}

function b58(bytes: Uint8Array): string {
  // Reuse the module's decoder inverse by encoding through a tiny base58.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [0];
  for (const byte of bytes) {
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
  for (let i = digits.length - 1; i >= 0; i -= 1) out += alphabet[digits[i]!];
  return out;
}

test("the signable message is the NEP-461 discriminant followed by the delegate action", () => {
  // 2^30 + 366 = 1073742190 -> little-endian 0x6e010040.
  assert.equal(signableMessage(GOLDEN).subarray(0, 4).toString("hex"), "6e010040");
  assert.equal(
    signableMessage(GOLDEN).subarray(4).toString("hex"),
    encodeDelegateAction(GOLDEN).toString("hex"),
  );
});

test("borsh encoding matches the near-js golden vector byte for byte", () => {
  assert.equal(signableMessage(GOLDEN).toString("hex"), GOLDEN_DELEGATE_HEX);
});

test("the delegate action hash is sha256 of the signable message", () => {
  const expected = createHash("sha256").update(signableMessage(GOLDEN)).digest("hex");
  assert.equal(delegateActionHash(GOLDEN).toString("hex"), expected);
});

test("a real ed25519 signature over the NEP-461 hash verifies", () => {
  const { raw, privateKey } = keypair();
  const action: DelegateAction = { ...GOLDEN, publicKey: `ed25519:${b58(raw)}` };
  const signature = cryptoSign(null, delegateActionHash(action), privateKey);
  assert.equal(verifySignedDelegateAction({ delegateAction: action, signature }), true);
});

test("tampering with the action invalidates the signature", () => {
  const { raw, privateKey } = keypair();
  const action: DelegateAction = { ...GOLDEN, publicKey: `ed25519:${b58(raw)}` };
  const signature = cryptoSign(null, delegateActionHash(action), privateKey);
  const tampered: DelegateAction = { ...action, nonce: 2n };
  assert.equal(verifySignedDelegateAction({ delegateAction: tampered, signature }), false);
});

test("the near-js golden signature verifies against its public key", () => {
  const signed = decodeSignedDelegateAction(signedBytes());
  assert.equal(signed.delegateAction.senderId, "bob.testnet");
  assert.equal(signed.delegateAction.actions[0]!.type, "Transfer");
  assert.equal(verifySignedDelegateAction(signed), true);
});

test("a signed delegate action round-trips through decode and encode", () => {
  const signed = decodeSignedDelegateAction(signedBytes());
  const reencoded = encodeDelegateActionWrapper(signed);
  assert.equal(reencoded[0], 8, "Action::Delegate discriminant");
  assert.equal(reencoded.subarray(1).toString("hex"), Buffer.from(signedBytes()).toString("hex"));
});

test("a nested delegate action is refused, not silently dropped", () => {
  const inner = encodeDelegateActionWrapper({
    delegateAction: GOLDEN,
    signature: Buffer.from(GOLDEN_SIGNATURE_HEX, "hex"),
  });
  // Splice a Delegate action (tag 8) into the inner action list by hand.
  const nested = Buffer.concat([
    Buffer.from([0x0b, 0x00, 0x00, 0x00]), Buffer.from("bob.testnet"),
    Buffer.from([0x0b, 0x00, 0x00, 0x00]), Buffer.from("bob.testnet"),
    Buffer.from([0x01, 0x00, 0x00, 0x00]), // one action
    Buffer.from([8]), inner,
    Buffer.alloc(8), Buffer.alloc(8), Buffer.from([0]), Buffer.alloc(32),
  ]);
  assert.throws(() => decodeSignedDelegateAction(new Uint8Array(nested)), (err: unknown) => {
    return err instanceof MetaTxError && err.code === "nested_delegate";
  });
});

test("trailing bytes after the signature are refused", () => {
  const extra = Buffer.concat([Buffer.from(signedBytes()), Buffer.from([0, 0])]);
  assert.throws(() => decodeSignedDelegateAction(new Uint8Array(extra)), (err: unknown) => {
    return err instanceof MetaTxError && err.code === "trailing_bytes";
  });
});

test("the relay plan pins receiver_id to the sender, as NEP-366 requires", () => {
  const signed = decodeSignedDelegateAction(signedBytes());
  const plan = planRelay(signed);
  assert.equal(plan.receiverId, signed.delegateAction.senderId);
  assert.equal(plan.broadcastable, false, "the custody wallet cannot emit an Action::Delegate");
  assert.equal(plan.actionBytes[0], 8);
  assert.equal(plan.signedHashHex, delegateActionHash(signed.delegateAction).toString("hex"));
});

test("policy rejects a receiver that is not on the allow-list", () => {
  const signed = decodeSignedDelegateAction(signedBytes());
  const result = validateDelegateAction(signed, { allowedReceivers: ["someone.else.near"] });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /not on the allow-list/);
});

test("policy rejects a sponsored method and an over-budget gas limit", () => {
  const { raw, privateKey } = keypair();
  const call: InnerAction = {
    type: "FunctionCall",
    methodName: "ft_transfer",
    args: new TextEncoder().encode("{}"),
    gas: 100_000_000_000_000n,
    deposit: 1n,
  };
  const action: DelegateAction = { ...GOLDEN, actions: [call], publicKey: `ed25519:${b58(raw)}` };
  const signature = cryptoSign(null, delegateActionHash(action), privateKey);
  const signed = { delegateAction: action, signature };
  assert.equal(validateDelegateAction(signed, { allowedReceivers: ["bob.testnet"], allowedMethods: ["pay"] }).ok, false);
  assert.equal(
    validateDelegateAction(signed, {
      allowedReceivers: ["bob.testnet"],
      allowedMethods: ["ft_transfer"],
      maxGas: 30_000_000_000_000n,
    }).ok,
    false,
  );
  assert.equal(
    validateDelegateAction(signed, {
      allowedReceivers: ["bob.testnet"],
      allowedMethods: ["ft_transfer"],
      maxGas: 200_000_000_000_000n,
      maxDepositYocto: 10n,
    }).ok,
    true,
  );
});

test("policy refuses an action whose signature does not verify", () => {
  const signed = decodeSignedDelegateAction(signedBytes());
  const forged = { ...signed, signature: new Uint8Array(64) };
  const result = validateDelegateAction(forged, { allowedReceivers: ["bob.testnet"] });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /signature does not match/);
});

test("the nonce guard refuses a replay but accepts a fresh nonce", () => {
  const guard = new NonceGuard();
  const key = GOLDEN.publicKey;
  assert.equal(guard.accept("bob.testnet", key, 5n), true);
  assert.equal(guard.accept("bob.testnet", key, 5n), false, "same nonce is a replay");
  assert.equal(guard.accept("bob.testnet", key, 4n), false, "a lower nonce is a replay");
  assert.equal(guard.accept("bob.testnet", key, 6n), true);
  assert.equal(guard.accept("other.testnet", key, 5n), true, "a different sender is a different key");
});

test("base58 decode matches the public key's own bytes", () => {
  const { raw } = keypair();
  const encoded = b58(raw);
  assert.deepEqual(Buffer.from(base58Decode(encoded)), Buffer.from(raw));
  assert.deepEqual(Buffer.from(base58Decode("1")), Buffer.from([0]));
  assert.deepEqual(Buffer.from(base58Decode("111")), Buffer.from([0, 0, 0]));
  assert.throws(() => base58Decode("0"), (err: unknown) => err instanceof MetaTxError && err.code === "bad_base58");
});

test("parsePublicKey accepts a prefixed or bare ed25519 key and rejects the rest", () => {
  const { raw } = keypair();
  const encoded = b58(raw);
  assert.equal(parsePublicKey(`ed25519:${encoded}`).length, 32);
  assert.equal(parsePublicKey(encoded).length, 32);
  assert.throws(() => parsePublicKey("secp256k1:abc"), (err: unknown) => err instanceof MetaTxError);
  assert.throws(() => parsePublicKey("ed25519:1111"), (err: unknown) => err instanceof MetaTxError);
});

test("the SPKI prefix used to verify is the standard ed25519 one", () => {
  // Guards the constant: rebuilding a key from raw bytes must round-trip.
  const { raw, publicKey } = keypair();
  const rebuilt = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
  assert.equal(rebuilt.export({ type: "spki", format: "der" }).toString("hex"), publicKey.export({ type: "spki", format: "der" }).toString("hex"));
});

test("a FunctionCall action encodes its method, args, gas and deposit", () => {
  const action: DelegateAction = {
    ...GOLDEN,
    actions: [
      {
        type: "FunctionCall",
        methodName: "pay",
        args: new TextEncoder().encode(JSON.stringify({ to: "bob" })),
        gas: 30_000_000_000_000n,
        deposit: 0n,
      },
    ],
  };
  const bytes = encodeDelegateAction(action);
  const decoded = decodeSignedDelegateAction(
    new Uint8Array(Buffer.concat([bytes, Buffer.from([0]), Buffer.alloc(64)])),
  );
  const inner = decoded.delegateAction.actions[0]!;
  assert.equal(inner.type, "FunctionCall");
  assert.equal(inner.type === "FunctionCall" && inner.methodName, "pay");
  assert.equal(inner.type === "FunctionCall" && Buffer.from(inner.args).toString(), '{"to":"bob"}');
  assert.equal(inner.type === "FunctionCall" && inner.gas, 30_000_000_000_000n);
});

test("the signing key used in the test is a real ed25519 private key", () => {
  const { privateKey } = keypair();
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
});
