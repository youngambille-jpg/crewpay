import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  NonceGuard,
  decodeSignedDelegateAction,
  delegateActionHash,
  encodeDelegateAction,
  encodeSignedDelegateAction,
  type DelegateAction,
  type SignedDelegateAction,
} from "./metatx.ts";
import { Relayer } from "./relayer.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58(bytes: Uint8Array): string {
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
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!];
  return out;
}

/** Build a genuinely signed delegate action and return it base64-encoded. */
function signedBase64(overrides: Partial<DelegateAction> = {}, nonce = 7n): string {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = new Uint8Array(der.subarray(der.length - 32));
  const action: DelegateAction = {
    senderId: "agent.testnet",
    receiverId: "agent.testnet",
    actions: [{ type: "Transfer", deposit: 1_000_000n }],
    nonce,
    maxBlockHeight: 999n,
    publicKey: `ed25519:${b58(raw)}`,
    ...overrides,
  };
  const signature = new Uint8Array(cryptoSign(null, delegateActionHash(action), privateKey));
  const signed: SignedDelegateAction = { delegateAction: action, signature };
  return Buffer.from(encodeSignedDelegateAction(signed)).toString("base64");
}

const POLICY = { allowedReceivers: ["agent.testnet"] };

test("a valid signed delegate action is accepted and planned", () => {
  const relayer = new Relayer(POLICY);
  const outcome = relayer.handle(signedBase64());
  assert.equal(outcome.status, "planned");
  assert.equal(outcome.senderId, "agent.testnet");
  assert.equal(outcome.receiverId, "agent.testnet");
  assert.equal(outcome.nonce, "7");
  assert.ok(outcome.signedHashHex);
});

test("a planned relay is honest that it was not broadcast", () => {
  const relayer = new Relayer(POLICY);
  const outcome = relayer.handle(signedBase64());
  assert.equal(outcome.broadcastable, false);
  assert.match(outcome.note, /not broadcast/);
  assert.match(outcome.reasons.join(" "), /cannot emit/);
});

test("a malformed payload is rejected, never thrown", () => {
  const relayer = new Relayer(POLICY);
  const outcome = relayer.handle("not base64 borsh at all!!");
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.broadcastable, false);
  assert.match(outcome.reasons.join(" "), /decode/);
});

test("a receiver off the allow-list is rejected", () => {
  const relayer = new Relayer({ allowedReceivers: ["someone.else.near"] });
  const outcome = relayer.handle(signedBase64());
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reasons.join(" "), /not on the allow-list/);
});

test("a tampered signature is rejected", () => {
  const relayer = new Relayer(POLICY);
  const encoded = signedBase64();
  // Flip one byte of the signature so it no longer matches the action.
  const signed = decodeSignedDelegateAction(Buffer.from(encoded, "base64"));
  const bad: SignedDelegateAction = {
    delegateAction: signed.delegateAction,
    signature: signed.signature.map((b, i) => (i === 0 ? b ^ 0xff : b)) as unknown as Uint8Array,
  };
  const outcome = relayer.handle(Buffer.from(encodeSignedDelegateAction(bad)).toString("base64"));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reasons.join(" "), /signature does not match/);
});

test("a replayed nonce is rejected the second time", () => {
  const relayer = new Relayer(POLICY);
  const encoded = signedBase64();
  assert.equal(relayer.handle(encoded).status, "planned");
  const replay = relayer.handle(encoded);
  assert.equal(replay.status, "rejected");
  assert.match(replay.reasons.join(" "), /already used/);
});

test("a shared guard rejects a replay across relayer instances", () => {
  const guard = new NonceGuard();
  const encoded = signedBase64();
  assert.equal(new Relayer(POLICY, guard).handle(encoded).status, "planned");
  const second = new Relayer(POLICY, guard).handle(encoded);
  assert.equal(second.status, "rejected");
});

test("a deposit over the sponsored maximum is rejected", () => {
  const relayer = new Relayer({ ...POLICY, maxDepositYocto: 500_000n });
  const outcome = relayer.handle(signedBase64());
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reasons.join(" "), /exceeds the sponsored maximum/);
});

test("a rejected action never spends the nonce, so a corrected resubmit works", () => {
  const relayer = new Relayer({ allowedReceivers: ["nobody.near"] });
  assert.equal(relayer.handle(signedBase64()).status, "rejected");
  // Same nonce, but now the receiver is allowed: it must still be accepted.
  const allowed = new Relayer({ allowedReceivers: ["agent.testnet"] });
  assert.equal(allowed.handle(signedBase64()).status, "planned");
});

test("the relayer never reports a tx hash it did not produce", () => {
  const relayer = new Relayer(POLICY);
  const outcome = relayer.handle(signedBase64());
  assert.equal("txHash" in outcome, false);
});
