import { createHash } from "node:crypto";

/**
 * A stable idempotency key for one logical funding operation. It is derived
 * from the operation id, not minted at random, so a retry after a timeout or a
 * dropped connection sends the same key and the server answers with the
 * original request instead of moving funds twice. The service dedups on the
 * key alone, so the same operation must never be given two different keys.
 */
export function idempotencyKey(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return `crewpay_${hash.digest("hex").slice(0, 32)}`;
}
