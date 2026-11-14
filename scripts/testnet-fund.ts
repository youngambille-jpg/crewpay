/**
 * Minimal NEAR testnet transfer signer. Test tooling only: it exists so the
 * testnet payout script can fund a fresh OutLayer wallet with gas without a
 * human faucet run. It signs bare Transfer actions and nothing else, talks
 * only to the RPC URL it is given (default testnet), and must never be pointed
 * at mainnet — there is no mainnet path that needs it.
 *
 * No dependencies: ed25519 comes from node:crypto, borsh for this one shape is
 * below, and base58 is twenty lines. The live broadcast is the test.
 */
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character: ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const tail: number[] = [];
  while (n > 0n) {
    tail.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let leading = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leading += 1;
  }
  return new Uint8Array([...new Array(leading).fill(0), ...tail]);
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function u128(n: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, n & 0xffffffffffffffffn, true);
  v.setBigUint64(8, n >> 64n, true);
  return b;
}

function borshStr(s: string): Uint8Array {
  const utf = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + utf.length);
  out.set(u32(utf.length), 0);
  out.set(utf, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface TestKeypair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly publicKeyRaw: Uint8Array;
  /** `ed25519:...` as NEAR writes it. */
  readonly publicKeyNear: string;
}

export function genKeypair(): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { publicKey, privateKey, publicKeyRaw, publicKeyNear: `ed25519:${b58encode(publicKeyRaw)}` };
}

/** Borsh Transaction with a single Transfer action. */
function buildTransferTx(args: {
  signerId: string;
  publicKeyRaw: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  yocto: bigint;
}): Uint8Array {
  return concat(
    borshStr(args.signerId),
    concat(new Uint8Array([0]), args.publicKeyRaw),
    u64(args.nonce),
    borshStr(args.receiverId),
    args.blockHash,
    u32(1),
    new Uint8Array([3]),
    u128(args.yocto),
  );
}

async function rpc(rpcUrl: string, f: typeof fetch, method: string, params: unknown): Promise<any> {
  const res = await f(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "fund", method, params }),
  });
  return (await res.json()) as any;
}

/** Round-trip sanity for the encoding and signing below. Throws on failure. */
export function selfTest(): void {
  const probe = new Uint8Array(32).map((_, i) => (i * 37 + 11) % 256);
  const round = b58decode(b58encode(probe));
  if (round.length !== 32 || !round.every((b, i) => b === probe[i])) {
    throw new Error("base58 round-trip failed");
  }
  const kp = genKeypair();
  const tx = buildTransferTx({
    signerId: "alice.testnet",
    publicKeyRaw: kp.publicKeyRaw,
    nonce: 1n,
    receiverId: "bob.testnet",
    blockHash: new Uint8Array(32).fill(7),
    yocto: 1n,
  });
  // Layout check: str(13)+key(33)+u64+str(11)+hash(32)+vec(4)+tag(1)+u128(16).
  if (tx.length !== 17 + 33 + 8 + 15 + 32 + 4 + 1 + 16) {
    throw new Error(`transfer layout drifted: ${tx.length} bytes`);
  }
  // NEAR signs the SHA-256 of the borsh bytes, not the bytes themselves.
  const digest = createHash("sha256").update(tx).digest();
  const sig = sign(null, digest, kp.privateKey);
  if (!verify(null, digest, kp.publicKey, sig)) throw new Error("ed25519 sign/verify failed");
  const tampered = new Uint8Array(tx);
  tampered[0]! ^= 1;
  if (verify(null, createHash("sha256").update(tampered).digest(), kp.publicKey, sig)) {
    throw new Error("signature check is vacuous");
  }
}

export interface TransferResult {
  readonly ok: boolean;
  readonly txHash: string;
  readonly error: string;
}

/** Sign and broadcast `yocto` NEAR from `from` to `to`. Sender key required. */
export async function broadcastTransfer(
  rpcUrl: string,
  f: typeof fetch,
  kp: TestKeypair,
  from: string,
  to: string,
  yocto: bigint,
): Promise<TransferResult> {
  const key = await rpc(rpcUrl, f, "query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: from,
    public_key: kp.publicKeyNear,
  });
  if (key["error"]) return { ok: false, txHash: "", error: `access key: ${JSON.stringify(key["error"]).slice(0, 160)}` };
  const block = await rpc(rpcUrl, f, "block", { finality: "final" });
  if (block["error"] || !block["result"]?.header?.hash) {
    return { ok: false, txHash: "", error: "could not read latest block" };
  }
  const tx = buildTransferTx({
    signerId: from,
    publicKeyRaw: kp.publicKeyRaw,
    nonce: BigInt(key["result"]["nonce"]) + 1n,
    receiverId: to,
    blockHash: b58decode(String(block["result"]["header"]["hash"])),
    yocto,
  });
  const digest = createHash("sha256").update(tx).digest();
  const sig = sign(null, digest, kp.privateKey);
  const signed = Buffer.from(concat(tx, new Uint8Array([0]), new Uint8Array(sig))).toString("base64");
  const sent = await rpc(rpcUrl, f, "broadcast_tx_commit", [signed]);
  const status = sent?.result?.status;
  if (status && typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status)) {
    return { ok: true, txHash: String(sent["result"]["transaction"]["hash"] ?? ""), error: "" };
  }
  return { ok: false, txHash: "", error: JSON.stringify(sent).slice(0, 300) };
}

/** Create a helper-funded named testnet account for `publicKeyNear`. */
export async function helperCreateAccount(
  helperUrl: string,
  f: typeof fetch,
  accountId: string,
  publicKeyNear: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await f(`${helperUrl}/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKeyNear }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    return { ok: true, detail: text.slice(0, 120) };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
