/**
 * Who is calling, and which org their data belongs to.
 *
 * The API previously trusted an `orgId` supplied by the caller. That is not a
 * scoping mechanism: anyone could ask for another org's payroll, and omitting
 * the parameter returned every org's rows at once. The org is a property of the
 * *caller*, so it is resolved here from a bearer token and never read from the
 * request body or query string again.
 *
 * This is service-level authentication (a shared secret identifies the client),
 * not user-level login. It closes anonymous access to the API; it does not yet
 * distinguish two humans using the same client.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The authenticated caller. `orgId` is the only org this caller may touch. */
export interface Principal {
  readonly orgId: string;
  /** For logs and diagnostics. Never a secret. */
  readonly label: string;
}

/**
 * token -> principal. A Map rather than a single token so a deployment can
 * hold one credential per org without any code change.
 */
export interface AuthConfig {
  readonly tokens: ReadonlyMap<string, Principal>;
}

/** Paths that are deliberately reachable without a bearer token. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  // Liveness. Reveals the rail name and nothing about any org.
  "/health",
  // Which external services are up. Unauthenticated on purpose so the landing
  // page can show real infrastructure rather than a hard-coded green light.
  "/v1/live/health",
  // Ping's webhook cannot present a bearer token. It carries an HMAC over the
  // raw body instead, verified in the handler; a bad signature is rejected
  // there. Adding it to this set does not make it unauthenticated.
  "/v1/webhooks/pingpay",
]);

/**
 * Hash before comparing. `timingSafeEqual` requires equal-length buffers, and
 * comparing raw tokens would leak their length; a fixed-width digest removes
 * both problems.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The bearer token on the request, or undefined when there is not one. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The principal behind a request, or undefined when it carries no valid token.
 * Every configured token is compared even after a match, so a wrong token costs
 * the same work as a right one and cannot be found by timing.
 */
export function resolvePrincipal(
  req: IncomingMessage,
  auth: AuthConfig,
): Principal | undefined {
  const presented = bearerToken(req);
  if (presented === undefined) return undefined;
  const presentedDigest = digest(presented);
  let found: Principal | undefined;
  for (const [token, principal] of auth.tokens) {
    if (timingSafeEqual(presentedDigest, digest(token))) found = principal;
  }
  return found;
}

/**
 * Auth for the tests, the demo and the e2e scripts — a single known token bound
 * to the seeded org. Deliberately not exported from the production entry point:
 * `serve.ts` requires a token from the environment and refuses to start without
 * one, so this cannot become the deployed default by accident.
 */
export const TEST_TOKEN = "test-token";

export function testAuth(orgId = "org_1"): AuthConfig {
  return { tokens: new Map([[TEST_TOKEN, { orgId, label: "test" }]]) };
}
