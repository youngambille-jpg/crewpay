import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AgentTask,
  Approval,
  ChainAsset,
  Invoice,
  InvoiceLineItem,
  InvoiceStatus,
  Operation,
  PayRun,
  PayRunItem,
  PayRunSource,
  Payee,
  PingWebhookEvent,
  Policy,
  UsdCents,
} from "@crewpay/domain";
import { defaultRules, corridor, invoiceStatusFor, invoiceStatusForPayment, lineItemAmount } from "@crewpay/domain";
import type { AgentPayPort, PingPayPort, Relayer, SettlementRail } from "@crewpay/rails";
import type { Signer } from "@crewpay/signer";
import { compileManifest, diffManifest, type ManifestDrift } from "@crewpay/signer";
import { executeApproved, executeRun, payAgentTask, resolveFunding } from "@crewpay/agent";
import { allBalanced, attestation, trialBalance } from "@crewpay/ledger";
import { activePolicy, createStore, notify, recordFunding, recordOutcome, resolveFundingRecord, type InvoicePayment, type Store } from "./store.ts";
import { FUNDING_CHAINS, LiveServices, toOutLayerRules } from "./live.ts";
import { resolvePrincipal, type AuthConfig, type Principal } from "./auth.ts";
import type { TestnetServices } from "./testnet.ts";

export interface ApiDeps {
  readonly rail: SettlementRail;
  /**
   * Who may call this API, and as which org. Required: there is no default,
   * because a default would mean the deployed API silently answers anonymous
   * callers. `serve.ts` builds it from the environment and refuses to start
   * without a token.
   */
  readonly auth: AuthConfig;
  /** Funds the rail's deposit address. Without it, runs are unfunded. */
  readonly signer?: Signer;
  /** Ping checkout + webhook verification. Without it, invoices are off. */
  readonly pingpay?: PingPayPort;
  /** Agent Pay facilitator (x402). Without it, agent task payouts are off. */
  readonly agentpay?: AgentPayPort;
  readonly store?: Store;
  /**
   * Live access to the real external services. Present in both modes: the
   * health check and the Connect flow are real regardless of whether the money
   * path is fake, so an operator can always see the true state of the rails.
   */
  readonly live?: LiveServices;
  /**
   * Testnet payout services (OutLayer testnet wallet + mock-USDT adapters).
   * Without it the /v1/testnet/* endpoints answer 400. The wallet key lives in
   * this holder only and is never returned to a caller.
   */
  readonly testnet?: TestnetServices;
  /**
   * NEP-366 gas relayer. Present when the deployment sponsors gas for payees
   * who hold none: a payee (or agent) signs a delegate action, the relayer
   * validates it and assembles the outer transaction. Without it, the
   * `/v1/relay` route answers 400.
   */
  readonly relayer?: Relayer;
}

/**
 * A request that has been authenticated, carrying the caller's org.
 *
 * Handlers take this instead of reading `orgId` from the request. The org a
 * caller may act on is a property of the caller, so it is resolved once, here,
 * and cannot be overridden by a query string or body field.
 */
interface Access {
  readonly principal: Principal;
  /**
   * The org to act on. Returns the caller's own org when none was requested,
   * and `undefined` when a *different* org was named — the caller must then be
   * told 404, not 403, so the API never confirms that another org's data
   * exists.
   */
  org(requested?: string | null): string | undefined;
}

function accessFor(principal: Principal): Access {
  return {
    principal,
    org(requested) {
      if (requested === null || requested === undefined || requested === "") {
        return principal.orgId;
      }
      return requested === principal.orgId ? principal.orgId : undefined;
    },
  };
}

/** The caller may not see or touch this resource. 404, never 403. */
function notFound(res: ServerResponse): void {
  send(res, 404, { error: "not found" });
}

interface PayRunRequest {
  readonly orgId: string;
  readonly period: string;
  readonly currency?: string;
  readonly origin?: { chain: string; asset: string };
  readonly lines: readonly { payeeId: string; usdCents: number }[];
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  // Money is bigint everywhere inside the app. JSON has no integer type that
  // is safe for it, so it crosses the wire as a string and the client parses
  // it — never as a float, which would round.
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  res.writeHead(status, {
    "content-type": "application/json",
    // The dashboard is served from a different origin than this API. These
    // handlers have no auth yet, so this is dev-grade: once auth lands, the
    // origin must be pinned and credentials sent explicitly.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-ping-signature, x-ping-timestamp",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

/**
 * Write a CSV attachment. Values are quoted only when they must be (RFC 4180),
 * and a leading `=`, `+`, `-` or `@` is prefixed with a quote so a spreadsheet
 * cannot interpret a memo as a formula — a bookkeeper's export should never
 * execute anything.
 */
function sendCsv(res: ServerResponse, filename: string, rows: readonly (readonly string[])[]): void {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function csvCell(value: string): string {
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(value);
  const guarded = needsFormulaGuard ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Create a pay run and execute it. Shared by the HTTP handler and the Ping
 * webhook: a paid invoice must go down exactly the same path as a posted run,
 * so the policy is enforced identically whether a human or a webhook started it.
 */
async function createPayRun(
  store: Store,
  deps: ApiDeps,
  body: PayRunRequest & { source?: PayRunSource; sourceRef?: string },
  via?: { rail: SettlementRail; signer?: Signer },
): Promise<Record<string, unknown> | { error: string }> {
  const policy = activePolicy(store, body.orgId);
  if (!policy) return { error: "no active policy for org" };

  const runId = `run_${store.payRuns.size + 1}`;
  const origin = body.origin ?? { chain: "base", asset: "usdc" };
  const items: { item: PayRunItem; operation: Operation }[] = [];
  let total = 0n;

  // Resolve every line's payee before touching the rail. A payee that belongs
  // to another org is as unknown as one that does not exist: paying it would
  // move the caller's money to a destination they were never granted.
  for (const line of body.lines) {
    const payee = store.payees.get(line.payeeId);
    if (!payee || payee.orgId !== body.orgId) {
      return { error: `unknown payee ${line.payeeId}` };
    }
  }

  body.lines.forEach((line, i) => {
    const payee = store.payees.get(line.payeeId)!;
    const operation: Operation = {
      id: `${runId}_op_${i + 1}`,
      orgId: body.orgId,
      payRunItemId: `${runId}_item_${i + 1}`,
      type: payee.kind === "agent" ? "agent_task_payout" : "payout",
      amount: { amount: BigInt(line.usdCents) * 10_000n, asset: origin.asset },
      usdCents: line.usdCents,
      origin,
      destination: payee.destination,
      corridor: corridor(origin, payee.destination),
      recipient: payee.address,
      refundTo: "crewpay.near",
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const item: PayRunItem = {
      id: operation.payRunItemId ?? `${runId}_item_${i + 1}`,
      payRunId: runId,
      payeeId: payee.id,
      amount: operation.amount,
      corridor: operation.corridor,
      operationId: operation.id,
      state: "pending",
    };
    store.operations.set(operation.id, operation);
    items.push({ item, operation });
    total += operation.amount.amount;
  });

  const rail = via?.rail ?? deps.rail;
  const signer = via?.signer ?? deps.signer;
  const result = await executeRun(
    body.orgId,
    policy,
    items,
    {
      rail,
      ...(signer ? { signer } : {}),
      lookupPayee: (id) => store.payees.get(id),
      payeeHasHistory: (id) => (store.payeeHistory.get(id) ?? 0) > 0,
      // The daily cap is per day, not per run: seed it with what already settled.
      spentTodayCents: store.settledTodayCents.get(body.orgId) ?? 0,
    },
  );

  // Lines start pending; each outcome below moves its line to a real state.
  // Pre-storing lets recordOutcome update them in place.
  store.payRunItems.set(runId, items.map((i) => i.item));

  for (const outcome of result.outcomes) {
    if (outcome.settlement?.status === "settled") {
      store.payeeHistory.set(outcome.payeeId, (store.payeeHistory.get(outcome.payeeId) ?? 0) + 1);
    }
    // Persist the books for every settled line. A settlement the journal does
    // not record is money the export cannot show.
    if (outcome.journal) store.journalEntries.push(outcome.journal);
    // Keep any funding we could not resolve: the request id is the only handle
    // that can tell us later whether that money moved. The quote rides along so
    // a later resolve can ask the rail whether the payee was actually paid.
    recordFunding(
      store,
      {
        orgId: body.orgId,
        operationId: outcome.operationId,
        payeeId: outcome.payeeId,
        ...(outcome.quote ? { railQuote: outcome.quote } : {}),
      },
      outcome.funding,
    );

    const codes = outcome.decision.reasons.map((r) => r.code);
    const base = {
      orgId: body.orgId,
      operationId: outcome.operationId,
      payeeId: outcome.payeeId,
      payRunId: runId,
      decision: outcome.decision.decision,
      reasonCodes: codes,
      policyId: outcome.decision.policyId,
      policyVersion: outcome.decision.policyVersion,
    };
    if (outcome.decision.decision === "deny") {
      recordOutcome(store, { ...base, status: "denied", note: `denied: ${codes.join(", ")}` });
      notify(store, {
        orgId: body.orgId,
        kind: "payee_denied",
        to: outcome.payeeId,
        refType: "operation",
        refId: outcome.operationId,
        message: `line for ${outcome.payeeId} denied (${codes.join(", ")})`,
      });
      continue;
    }
    if (outcome.decision.decision === "allow_with_approval") {
      recordOutcome(store, { ...base, status: "awaiting_approval" });
      continue;
    }
    if (outcome.journal && outcome.settlement?.status === "settled") {
      recordOutcome(store, {
        ...base,
        status: "settled",
        ...(outcome.settlement.quoteId ? { quoteId: outcome.settlement.quoteId } : {}),
        ...(outcome.settlement.txHash ? { txHash: outcome.settlement.txHash } : {}),
        ...(outcome.settlement.evidence ? { evidence: outcome.settlement.evidence } : {}),
        journalEntryId: outcome.journal.id,
      });
      notify(store, {
        orgId: body.orgId,
        kind: "payee_paid",
        to: outcome.payeeId,
        refType: "operation",
        refId: outcome.operationId,
        message: `paid ${outcome.payeeId} (operation ${outcome.operationId})`,
      });
    } else if (result.failed.includes(outcome.operationId)) {
      const reason =
        outcome.settlement?.failureReason ??
        (outcome.funding?.kind === "failed" ? outcome.funding.reason : "settlement failed");
      recordOutcome(store, { ...base, status: "failed", note: reason });
      notify(store, {
        orgId: body.orgId,
        kind: "payout_failed",
        to: "owner",
        refType: "operation",
        refId: outcome.operationId,
        message: `payout ${outcome.operationId} failed: ${reason}`,
      });
    } else {
      // Unknown fund state or still in flight: submitted somewhere, outcome
      // unconfirmed. The worklist owns it from here.
      const reason =
        outcome.settlement?.failureReason ??
        (outcome.funding && "reason" in outcome.funding ? outcome.funding.reason : "settlement unresolved");
      recordOutcome(store, { ...base, status: "submitted", note: reason });
      notify(store, {
        orgId: body.orgId,
        kind: "payout_needs_review",
        to: "owner",
        refType: "operation",
        refId: outcome.operationId,
        message: `payout ${outcome.operationId} needs review: ${reason}`,
      });
    }
  }
  store.settledTodayCents.set(
    body.orgId,
    (store.settledTodayCents.get(body.orgId) ?? 0) + result.settledCents,
  );

  // Open an approval for each operation the policy held back, freezing the
  // operation as it was evaluated. The approver signs off on exactly this.
  const approvalIds: string[] = [];
  for (const outcome of result.outcomes) {
    if (outcome.decision.decision !== "allow_with_approval") continue;
    const operation = store.operations.get(outcome.operationId);
    if (!operation) continue;
    const approval: Approval = {
      id: `apv_${store.approvals.size + 1}`,
      orgId: body.orgId,
      operationId: operation.id,
      operation,
      payeeId: outcome.payeeId,
      policyId: outcome.decision.policyId,
      policyVersion: outcome.decision.policyVersion,
      reasonCodes: outcome.decision.reasons.map((r) => r.code),
      status: "pending",
      requestedBy: body.source === "invoice" ? "pingpay" : "api",
      requestedAt: new Date().toISOString(),
    };
    store.approvals.set(approval.id, approval);
    approvalIds.push(approval.id);
    notify(store, {
      orgId: body.orgId,
      kind: "approval_needed",
      to: "owner",
      refType: "approval",
      refId: approval.id,
      message: `approval ${approval.id} needs a decision (operation ${operation.id})`,
    });
  }

  const run: PayRun = {
    id: runId,
    orgId: body.orgId,
    source: body.source ?? "api",
    ...(body.sourceRef ? { sourceRef: body.sourceRef } : {}),
    period: body.period,
    currency: body.currency ?? origin.asset,
    status:
      result.denied.length + result.failed.length + result.needsReview.length === 0 &&
      result.awaitingApproval.length === 0
        ? "settled"
        : result.settledCents > 0
          ? "partially_settled"
          : "awaiting_approval",
    createdBy: "api",
    createdAt: new Date().toISOString(),
  };
  store.payRuns.set(runId, run);

  return {
    run,
    settledCents: result.settledCents,
    awaitingApproval: result.awaitingApproval,
    approvals: approvalIds,
    denied: result.denied,
    failed: result.failed,
    needsReview: result.needsReview,
    total: total.toString(),
  };
}

/**
 * The control plane. It owns org state and orchestration but never moves money:
 * it hands operations to the agent, which settles them through the rail. In the
 * full design these handlers sit behind auth, a Postgres store and a job queue;
 * here they run in-process against an in-memory store.
 */
export function createApi(deps: ApiDeps): { server: Server; store: Store } {
  const store = deps.store ?? createStore();

  const server = createServer((req, res) => {
    handle(req, res, store, deps).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    });
  });

  return { server, store };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  deps: ApiDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  // Browsers preflight a cross-origin JSON POST. Answer it before any routing
  // so the dashboard can call the API from another origin.
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, x-ping-signature, x-ping-timestamp",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, rail: deps.rail.name });
  }

  // The real state of the three external services. Unauthenticated and cheap,
  // so the landing page and the dashboard can both show live infrastructure
  // rather than a hard-coded "all systems go".
  if (method === "GET" && url.pathname === "/v1/live/health") {
    if (!deps.live) return send(res, 200, { services: [], allUp: false });
    const force = url.searchParams.get("refresh") === "1";
    const health = await deps.live.health(force ? 0 : 30_000);
    return send(res, 200, health);
  }

  // Ping's webhook authenticates with an HMAC over the raw body, not a token,
  // so it is answered here. Everything below this point requires a principal.
  if (method === "POST" && url.pathname === "/v1/webhooks/pingpay") {
    return handlePingWebhook(req, res, store, deps);
  }

  // Public pay page. The invoice id is the capability: whoever holds the link
  // may see the amount and pay it. No org data, no other invoice, no policy, no
  // bearer token — just this one obligation and how to settle it.
  if (method === "GET" && url.pathname.startsWith("/v1/pay/")) {
    const rest = decodeURIComponent(url.pathname.slice("/v1/pay/".length));
    if (rest.endsWith("/status")) {
      const invoiceId = rest.slice(0, -"/status".length);
      return publicInvoiceStatus(res, store, deps, invoiceId);
    }
    return publicInvoiceView(res, store, deps, rest);
  }

  if (method === "POST" && url.pathname.startsWith("/v1/pay/") && url.pathname.endsWith("/quote")) {
    const invoiceId = decodeURIComponent(url.pathname.slice("/v1/pay/".length, -"/quote".length));
    const body = (await readJson(req)) as { originChain?: string; amountUsdCents?: number };
    return publicInvoiceQuote(res, store, deps, invoiceId, body);
  }

  // The gate. A request without a valid token is answered here and can never
  // reach a handler that reads or writes money — the routing below is reachable
  // only with a principal in hand. This is why the check is one branch rather
  // than a call inside every handler: a handler added later is protected by
  // default instead of by remembering to protect it.
  const principal = resolvePrincipal(req, deps.auth);
  if (!principal) {
    return send(res, 401, { error: "authentication required" });
  }
  const access = accessFor(principal);

  // Provision a real custody wallet. This is the demo's "connect" step: it mints
  // a real OutLayer wallet with a real `wk_` key. The key stays in this process;
  // the client only ever sees the public account id and the handoff link.
  if (method === "POST" && url.pathname === "/v1/connect") {
    if (!deps.live) return send(res, 400, { error: "live services not configured" });
    try {
      const wallet = await deps.live.connect();
      return send(res, 201, {
        connected: true,
        wallet,
        // Stated plainly so no screen implies funds are present: the wallet is
        // real but empty, and only a funded wallet can broadcast.
        funded: false,
        note: "Real testnet-free wallet. Deposit to broadcast for real.",
      });
    } catch (err) {
      return send(res, 502, {
        error: err instanceof Error ? err.message : "connect failed",
      });
    }
  }

  if (method === "GET" && url.pathname === "/v1/connect") {
    const wallet = deps.live?.connected;
    if (!wallet) return send(res, 200, { connected: false });
    // Only a boolean crosses the wire. The handoff URL carries the wallet key in
    // its query string, so it is never serialised to a client — the browser is
    // sent to /v1/connect/handoff, which redirects server-side.
    return send(res, 200, {
      connected: true,
      wallet,
      funded: false,
      hasHandoff: Boolean(deps.live?.handoffUrl),
    });
  }

  // Redirect to the custody provider's dashboard. The URL embeds the wallet key,
  // so it is never returned as JSON — a redirect keeps it out of the page, the
  // DOM, and any client-side cache, and it still lands the operator in the right
  // wallet.
  if (method === "GET" && url.pathname === "/v1/connect/handoff") {
    const target = deps.live?.handoffUrl;
    if (!target) return send(res, 404, { error: "no custody handoff available" });
    res.writeHead(302, { location: target });
    res.end();
    return;
  }

  // Publish the org policy AND compile it into the blob the TEE enforces. The
  // local policy governs CrewPay's own decisions; the compiled blob is the real
  // custody-layer limit. Publishing both keeps them from drifting apart.
  if (method === "POST" && url.pathname === "/v1/policies/publish") {
    const body = (await readJson(req)) as { orgId: string; rules?: Record<string, unknown> };
    if (!deps.live) return send(res, 400, { error: "live services not configured" });
    if (!deps.live.connected) {
      return send(res, 409, { error: "connect a custody wallet before publishing policy" });
    }
    try {
      const compiled = await deps.live.compilePolicy(toOutLayerRules(body.rules ?? {}));
      // Sign it too: that is as far as we can go without a funded account, and
      // it gives the owner everything needed to store the policy themselves.
      const signed = await deps.live.signPolicy(compiled.ciphertext);
      return send(res, 201, {
        published: true,
        walletId: compiled.walletId,
        ciphertext: compiled.ciphertext,
        ciphertextBytes: compiled.ciphertext.length,
        signed,
        // The honest limit: compiled and signed, but not yet enforced on-chain.
        policyState: "compiled",
        note: "Compiled and signed. Storing it on-chain needs a funded account.",
      });
    } catch (err) {
      return send(res, 502, { error: err instanceof Error ? err.message : "publish failed" });
    }
  }

  // Ask the TEE whether a withdraw would pass. Runs the real policy and balance
  // check with no signing and no broadcast — the core of the no-funds demo.
  if (method === "POST" && url.pathname === "/v1/live/dry-run") {
    const body = (await readJson(req)) as {
      chain: string;
      amount: string;
      to: string;
      token?: string;
    };
    if (!deps.live) return send(res, 400, { error: "live services not configured" });
    if (!deps.live.connected) {
      return send(res, 409, { error: "connect a custody wallet first" });
    }
    try {
      const result = await deps.live.dryRunWithdraw(body);
      return send(res, 200, result);
    } catch (err) {
      return send(res, 502, { error: err instanceof Error ? err.message : "dry-run failed" });
    }
  }

  // The policy the TEE actually enforces, plus the intents balance. Read-only.
  // `policyState` is the TEE's own answer, so a screen can say whether our
  // limits are merely compiled or genuinely enforced.
  if (method === "GET" && url.pathname === "/v1/live/custody") {
    if (!deps.live) return send(res, 400, { error: "live services not configured" });
    if (!deps.live.connected) return send(res, 200, { connected: false });
    try {
      const [policy, state, balance] = await Promise.all([
        deps.live.effectivePolicy(),
        deps.live.policyState(),
        deps.live.intentsBalance("nep141:wrap.near"),
      ]);
      return send(res, 200, {
        connected: true,
        policy,
        // "stored" means the enclave enforces it; "none" means it does not, so
        // a passing dry-run is not yet evidence that our policy allowed it.
        policyState: state.state,
        policyVersion: state.version,
        intentsBalance: balance,
      });
    } catch (err) {
      return send(res, 502, { error: err instanceof Error ? err.message : "custody read failed" });
    }
  }

  if (method === "POST" && url.pathname === "/v1/payees") {
    const body = (await readJson(req)) as Payee;
    // The org is the caller's, not the body's: a caller cannot file a payee
    // into someone else's org by naming it.
    const payee: Payee = { ...body, orgId: access.principal.orgId };
    store.payees.set(payee.id, payee);
    if (!store.payeeHistory.has(payee.id)) store.payeeHistory.set(payee.id, 0);
    return send(res, 201, payee);
  }

  if (method === "GET" && url.pathname === "/v1/payees") {
    // Previously an omitted `orgId` returned every org's payees. Now the caller
    // sees their own org, and naming another org is a 404.
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const all = [...store.payees.values()].filter((p) => p.orgId === orgId);
    return send(res, 200, all);
  }

  if (method === "POST" && url.pathname === "/v1/policies") {
    const body = (await readJson(req)) as Partial<Policy> & { orgId?: string };
    const requested = access.org(body.orgId);
    if (!requested) return notFound(res);
    const previous = activePolicy(store, requested);
    const policy: Policy = {
      id: body.id ?? `pol_${store.policies.size + 1}`,
      orgId: requested,
      // Each POST publishes a new version, so a decision can always be traced
      // to the rules in force when it was made.
      version: body.version ?? (previous ? previous.version + 1 : 1),
      active: body.active ?? true,
      rules: body.rules ?? defaultRules(),
    };
    // Exactly one active policy per org: the new version supersedes the old,
    // otherwise a stale policy would keep authorising operations.
    if (policy.active && previous) {
      store.policies.set(previous.id, { ...previous, active: false });
    }
    store.policies.set(policy.id, policy);
    return send(res, 201, policy);
  }

  if (method === "GET" && url.pathname === "/v1/policies") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    // The active policy only: superseded versions exist to make past decisions
    // replayable, not to be edited.
    const policy = activePolicy(store, orgId);
    if (!policy) return send(res, 404, { error: "no active policy for org" });
    return send(res, 200, policy);
  }

  if (method === "POST" && url.pathname === "/v1/pay-runs") {
    const body = (await readJson(req)) as PayRunRequest;
    const orgId = access.org(body.orgId);
    if (!orgId) return notFound(res);
    const result = await createPayRun(store, deps, { ...body, orgId });
    if ("error" in result) return send(res, 400, result);
    return send(res, 201, result);
  }

  if (method === "GET" && url.pathname === "/v1/pay-runs") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    // Newest first, each run carrying its lines so a caller can render progress
    // without a second request per run. Ties on createdAt (two runs created in
    // the same millisecond) break on insertion order, newest last-inserted
    // first, so the order is deterministic rather than left to the Map.
    const runs = [...store.payRuns.entries()]
      .filter(([, r]) => r.orgId === orgId)
      .map(([id, run], index) => ({ run, id, index }))
      .sort((a, b) =>
        b.run.createdAt.localeCompare(a.run.createdAt) || b.index - a.index,
      )
      .map(({ run, id }) => ({ ...run, id, items: store.payRunItems.get(id) ?? [] }));
    return send(res, 200, runs);
  }

  if (method === "POST" && url.pathname === "/v1/invoices") {
    if (!deps.pingpay) return send(res, 400, { error: "no pingpay client configured" });
    const body = (await readJson(req)) as {
      orgId?: string;
      customerId: string;
      amount: UsdCents;
      lineItems?: readonly { description?: string; quantity?: number; unitAmount?: number }[];
      dueDate?: string;
      settlementAsset?: ChainAsset;
      successUrl?: string;
      cancelUrl?: string;
      /** Optional: open the pay run the moment the invoice is paid. */
      autoPayRun?: { payeeId: string; origin?: ChainAsset };
    };
    const orgId = access.org(body.orgId);
    if (!orgId) return notFound(res);
    const asset = body.settlementAsset ?? { chain: "near", asset: "usdc" };

    // Line items are optional, but a malformed one is refused rather than
    // silently dropped: a total that disagrees with its lines is worse than no
    // breakdown at all for the bookkeeper reading the export.
    let lineItems: InvoiceLineItem[] | undefined;
    if (body.lineItems && body.lineItems.length > 0) {
      lineItems = [];
      for (const raw of body.lineItems) {
        const description = (raw.description ?? "").trim();
        const quantity = raw.quantity ?? 1;
        const unitAmount = raw.unitAmount ?? 0;
        if (!description) return send(res, 400, { error: "every line item needs a description" });
        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
          return send(res, 400, { error: "line item quantity must be a positive integer" });
        }
        if (!Number.isSafeInteger(unitAmount) || unitAmount < 0) {
          return send(res, 400, { error: "line item unitAmount must be a non-negative integer (cents)" });
        }
        lineItems.push({ description, quantity, unitAmount, amount: lineItemAmount(quantity, unitAmount) });
      }
      const sum = lineItems.reduce((total, line) => total + line.amount, 0);
      if (sum !== body.amount) {
        return send(res, 400, { error: `line items sum to ${sum} cents, but the amount is ${body.amount}` });
      }
    }

    if (body.dueDate !== undefined && Number.isNaN(Date.parse(body.dueDate))) {
      return send(res, 400, { error: "dueDate must be an ISO date" });
    }

    const session = await deps.pingpay.createCheckout({
      amount: body.amount,
      asset,
      ...(body.successUrl ? { successUrl: body.successUrl } : {}),
      ...(body.cancelUrl ? { cancelUrl: body.cancelUrl } : {}),
      customerReference: body.customerId,
    });
    const invoice: Invoice = {
      id: `inv_${store.invoices.size + 1}`,
      orgId,
      customerId: body.customerId,
      amount: body.amount,
      ...(lineItems ? { lineItems } : {}),
      ...(body.dueDate ? { dueDate: body.dueDate } : {}),
      settlementAsset: asset,
      status: invoiceStatusFor(session.status),
      checkoutSessionId: session.sessionId,
      checkoutUrl: session.sessionUrl ?? "",
      createdAt: new Date().toISOString(),
      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
    };
    store.invoices.set(invoice.id, invoice);
    if (body.autoPayRun) {
      // Remembered so a settled webhook can open the pay run without the
      // caller having to repeat the payee.
      store.invoicePayRuns.set(invoice.id, {
        payeeId: body.autoPayRun.payeeId,
        ...(body.autoPayRun.origin ? { origin: body.autoPayRun.origin } : {}),
      });
    }
    return send(res, 201, invoice);
  }

  if (method === "GET" && url.pathname === "/v1/invoices") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const all = [...store.invoices.values()]
      .filter((i) => i.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, all);
  }

  // One run with its lines, each line carrying its decision record and, once
  // settled, its receipt. This is the run summary the dashboard renders.
  if (method === "GET" && url.pathname.startsWith("/v1/pay-runs/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/pay-runs/".length));
    if (!id || id.includes("/")) return send(res, 404, { error: "not found" });
    const run = store.payRuns.get(id);
    // A run belonging to another org is reported as absent, not forbidden: a
    // 403 would confirm the id exists.
    if (!run || run.orgId !== access.principal.orgId) return send(res, 404, { error: "run not found" });
    const items = (store.payRunItems.get(id) ?? []).map((item) => {
      const record = item.operationId ? store.operationRecords.get(item.operationId) : undefined;
      const receipt = item.operationId ? store.receipts.get(item.operationId) : undefined;
      return { ...item, ...(record ? { record } : {}), ...(receipt ? { receipt } : {}) };
    });
    return send(res, 200, { run, items });
  }

  // Every operation with its policy decision and settlement state.
  if (method === "GET" && url.pathname === "/v1/operations") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const status = url.searchParams.get("status");
    const rows = [...store.operations.values()]
      .filter((op) => op.orgId === orgId)
      .map((operation) => {
        const record = store.operationRecords.get(operation.id);
        if (status && record?.status !== status) return null;
        const receipt = store.receipts.get(operation.id);
        return { operation, ...(record ? { record } : {}), ...(receipt ? { receipt } : {}) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    return send(res, 200, rows);
  }

  // The notification outbox: who was told what, and about which money.
  if (method === "GET" && url.pathname === "/v1/notifications") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const all = store.notifications.filter((n) => n.orgId === orgId);
    return send(res, 200, all);
  }

  if (method === "GET" && url.pathname === "/v1/manifest") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const policy = activePolicy(store, orgId);
    if (!policy) return send(res, 400, { error: "no active policy for org" });

    const approvers = url.searchParams.get("approvers")?.split(",").filter(Boolean) ?? [];
    const thresholdParam = url.searchParams.get("threshold");
    const timezone = url.searchParams.get("timezone");
    const compiled = compileManifest(policy.rules, {
      approvers,
      ...(thresholdParam ? { threshold: Number(thresholdParam) } : {}),
      ...(timezone ? { timezone } : {}),
    });

    // The policy the TEE enforces is the owner's, so read it and diff rather
    // than assume ours was installed. Absent a custody signer there is nothing
    // to compare against, and the manifest stands alone.
    let drift: readonly ManifestDrift[] | undefined;
    let effective: Record<string, unknown> | undefined;
    if (deps.signer?.custody) {
      effective = await deps.signer.custody.effectivePolicy();
      drift = diffManifest(compiled.manifest, effective);
    }

    return send(res, 200, {
      policyId: policy.id,
      policyVersion: policy.version,
      manifest: compiled.manifest,
      warnings: compiled.warnings,
      ...(effective ? { effectivePolicy: effective } : {}),
      ...(drift ? { drift } : {}),
    });
  }

  if (method === "GET" && url.pathname === "/v1/custody/approvals") {
    // The wallet's own multisig inbox. A request stuck at `pending_approval`
    // settles only when a human votes, so it is read here rather than polled.
    if (!deps.signer?.custody) return send(res, 200, []);
    return send(res, 200, await deps.signer.custody.openApprovals());
  }

  if (method === "GET" && url.pathname === "/v1/custody/requests") {
    // The worklist: funding requests we could not resolve. These are the ones
    // where funds may have moved and the outcome we recorded is only a snapshot.
    // Resolved records are filtered out — the list exists to show what still
    // needs a human, and an answered question does not.
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const rows = [...store.fundingRequests.values()].filter(
      (r) => !r.resolution && r.orgId === orgId,
    );
    return send(res, 200, rows);
  }

  if (method === "GET" && url.pathname.startsWith("/v1/custody/requests/")) {
    // Re-read one request from the custody service. Read-only by design: the
    // point is to learn the true state without moving money a second time, so
    // this never re-submits, however the request looks.
    const requestId = decodeURIComponent(url.pathname.slice("/v1/custody/requests/".length));
    const record = store.fundingRequests.get(requestId);
    if (!record || record.orgId !== access.principal.orgId) {
      return send(res, 404, { error: "unknown funding request" });
    }
    if (!deps.signer?.reconcile) {
      return send(res, 400, { error: "no reconciling signer configured", record });
    }
    const state = await deps.signer.reconcile(requestId);
    return send(res, 200, { record, state });
  }

  const resolveMatch = /^\/v1\/custody\/requests\/([^/]+)\/resolve$/.exec(url.pathname);
  if (method === "POST" && resolveMatch) {
    const requestId = decodeURIComponent(resolveMatch[1]!);
    const record = store.fundingRequests.get(requestId);
    // Another org's funding request is invisible here, and it must be: resolving
    // re-reads the rail and can book a settlement, so an unowned id is a write
    // against someone else's books.
    if (!record || record.orgId !== access.principal.orgId) {
      return send(res, 404, { error: "unknown funding request" });
    }
    if (!deps.signer?.reconcile) {
      return send(res, 400, { error: "no reconciling signer configured", record });
    }

    // The endpoint may only re-read: an unresolved funding is one where a
    // second submit could send the money twice. A query flag that asked for a
    // retry is refused rather than quietly ignored, so no caller believes a
    // payment was re-driven when it was not.
    if (url.searchParams.get("retry") === "true") {
      return send(res, 400, {
        error:
          "resolve never re-submits a funding request; the funds may already have moved",
        record,
      });
    }

    // Already answered: report the same answer rather than re-deciding. This is
    // what makes a retry after a lost response safe.
    if (record.resolution) {
      return send(res, 200, {
        resolved: true,
        outcome: record.resolution,
        duplicate: true,
        reason: record.resolutionNote,
      });
    }

    const operation = store.operations.get(record.operationId);
    const outcome = await resolveFunding({
      signer: deps.signer,
      // An agent task settles through the x402 facilitator, not the 1Click
      // rail. Asking the wrong service would answer about a different deposit.
      ...(record.settlesVia === "agentpay" ? {} : { rail: deps.rail }),
      ...(record.settlesVia ? { settlesVia: record.settlesVia } : {}),
      requestId,
      ...(operation ? { operation } : {}),
      ...(record.railQuote ? { railQuote: record.railQuote } : {}),
    });

    if (outcome.kind === "open") {
      // Still unanswered. Update what we know, but keep it on the worklist.
      store.fundingRequests.set(requestId, { ...record, reason: outcome.reason });
      return send(res, 200, { resolved: false, outcome: "open", reason: outcome.reason, record });
    }

    if (outcome.kind === "settled") {
      // Only now is the payee paid, so only now may the books record it. Guard
      // on the entry id so a second resolve is a no-op, not a second posting.
      const already = store.journalEntries.some((e) => e.id === outcome.journal.id);
      if (!already) {
        store.journalEntries.push(outcome.journal);
        if (record.payeeId) {
          store.payeeHistory.set(record.payeeId, (store.payeeHistory.get(record.payeeId) ?? 0) + 1);
        }
      }
      // A pay-run line closes into the read model too: the decision was
      // recorded at run time, so only the status and evidence are new. (An
      // agent-task funding has no operation record; its task already holds the
      // receipt.)
      const prior = store.operationRecords.get(record.operationId);
      if (prior) {
        recordOutcome(store, {
          orgId: prior.orgId,
          operationId: prior.operationId,
          payeeId: prior.payeeId,
          ...(prior.payRunId ? { payRunId: prior.payRunId } : {}),
          decision: prior.decision,
          reasonCodes: prior.reasonCodes,
          policyId: prior.policyId,
          policyVersion: prior.policyVersion,
          status: "settled",
          ...(outcome.settlement.quoteId ? { quoteId: outcome.settlement.quoteId } : {}),
          ...(outcome.settlement.txHash ? { txHash: outcome.settlement.txHash } : {}),
          ...(outcome.settlement.evidence ? { evidence: outcome.settlement.evidence } : {}),
          journalEntryId: outcome.journal.id,
        });
      }
      notify(store, {
        orgId: record.orgId,
        kind: "payee_paid",
        to: record.payeeId ?? "owner",
        refType: "funding_request",
        refId: requestId,
        message: `payout ${record.operationId} settled on re-read (request ${requestId})`,
      });
      resolveFundingRecord(store, requestId, "settled");
      return send(res, 200, {
        resolved: true,
        outcome: "settled",
        journal: outcome.journal,
        deposit: outcome.deposit,
        duplicate: already,
      });
    }

    // Terminal failure: the money is accounted for (refunded, never sent, or a
    // rail that will not complete), so the question is answered. The line leaves
    // its waiting state too.
    const priorFailed = store.operationRecords.get(record.operationId);
    if (priorFailed) {
      recordOutcome(store, {
        orgId: priorFailed.orgId,
        operationId: priorFailed.operationId,
        payeeId: priorFailed.payeeId,
        ...(priorFailed.payRunId ? { payRunId: priorFailed.payRunId } : {}),
        decision: priorFailed.decision,
        reasonCodes: priorFailed.reasonCodes,
        policyId: priorFailed.policyId,
        policyVersion: priorFailed.policyVersion,
        status: "failed",
        note: outcome.reason,
      });
    }
    notify(store, {
      orgId: record.orgId,
      kind: "payout_failed",
      to: "owner",
      refType: "funding_request",
      refId: requestId,
      message: `payout ${record.operationId} failed on re-read: ${outcome.reason}`,
    });
    resolveFundingRecord(store, requestId, "failed", outcome.reason);
    return send(res, 200, {
      resolved: true,
      outcome: "failed",
      reason: outcome.reason,
      deposit: outcome.deposit,
    });
  }

  // Testnet wallet: register (or reuse) the server-held OutLayer testnet
  // wallet. The key never leaves this process; callers get the account id and
  // read its on-chain state through the status endpoint below.
  if (method === "POST" && url.pathname === "/v1/testnet/wallet") {
    if (!deps.testnet) return send(res, 400, { error: "testnet services not configured" });
    try {
      const { account, reused } = await deps.testnet.register();
      return send(res, reused ? 200 : 201, { connected: true, account, reused });
    } catch (err) {
      return send(res, 502, { error: err instanceof Error ? err.message : "register failed" });
    }
  }

  if (method === "GET" && url.pathname === "/v1/testnet/wallet") {
    if (!deps.testnet) return send(res, 400, { error: "testnet services not configured" });
    return send(res, 200, await deps.testnet.status());
  }

  // Prepare a payout: report gas, register the wallet, mint mock USDT, and
  // register the recipient. Steps run once each; repeats report rather than
  // re-spend. Never throws for an unfunded wallet — it reports what is missing.
  if (method === "POST" && url.pathname === "/v1/testnet/prepare") {
    if (!deps.testnet) return send(res, 400, { error: "testnet services not configured" });
    const body = (await readJson(req)) as { recipient?: string; minUsdtBase?: string };
    if (!body.recipient) return send(res, 400, { error: "recipient is required" });
    let min = 0n;
    try {
      min = BigInt(body.minUsdtBase ?? "0");
    } catch {
      return send(res, 400, { error: "minUsdtBase must be an integer string" });
    }
    try {
      return send(res, 200, await deps.testnet.prepare(body.recipient, min));
    } catch (err) {
      return send(res, 409, { error: err instanceof Error ? err.message : "prepare failed" });
    }
  }

  // Mint mock USDT.e to the held testnet wallet. The console's faucet: a real
  // on-chain mint of the fakes token, so the wallet can pay out before a pay
  // run. Gas is a human step (only a human can send the first NEAR); without it
  // the route reports what is missing rather than failing opaquely.
  if (method === "POST" && url.pathname === "/v1/testnet/mint") {
    if (!deps.testnet) return send(res, 400, { error: "testnet services not configured" });
    const body = (await readJson(req)) as { amountBase?: string };
    let amount: bigint | undefined;
    if (body.amountBase !== undefined) {
      try {
        amount = BigInt(body.amountBase);
      } catch {
        return send(res, 400, { error: "amountBase must be an integer string" });
      }
      if (amount <= 0n) return send(res, 400, { error: "amountBase must be positive" });
    }
    try {
      return send(res, 200, await deps.testnet.mint(amount));
    } catch (err) {
      return send(res, 409, { error: err instanceof Error ? err.message : "mint failed" });
    }
  }

  // A pay run that settles in mock USDT on testnet instead of the wired rail.
  // Policy, approvals, ledger, receipts and notifications are the real loop —
  // only the adapters differ — and the run carries sourceRef "testnet" so mock
  // settlements are never mistaken for mainnet money in the books.
  if (method === "POST" && url.pathname === "/v1/testnet/pay-runs") {
    if (!deps.testnet) return send(res, 400, { error: "testnet services not configured" });
    const adapters = deps.testnet.adapters();
    if (!adapters) return send(res, 409, { error: "register a testnet wallet first" });
    const body = (await readJson(req)) as PayRunRequest;
    const orgId = access.org(body.orgId);
    if (!orgId) return notFound(res);
    const result = await createPayRun(store, deps, { ...body, orgId, sourceRef: "testnet" }, adapters);
    if ("error" in result) return send(res, 400, result);
    return send(res, 201, result);
  }

  // NEP-366 gas relay: a payee (or agent) that holds no NEAR signs a delegate
  // action and posts it here; the relayer verifies the signature, checks it
  // against the policy and assembles the outer transaction. It never claims a
  // broadcast it did not make.
  if (method === "POST" && url.pathname === "/v1/relay") {
    if (!deps.relayer) return send(res, 400, { error: "relayer not configured" });
    const body = (await readJson(req)) as { signedDelegateAction?: string };
    if (typeof body.signedDelegateAction !== "string" || body.signedDelegateAction.length === 0) {
      return send(res, 400, { error: "signedDelegateAction (base64 borsh) is required" });
    }
    const outcome = deps.relayer.handle(body.signedDelegateAction);
    // A rejection is the caller's problem to fix, so it is a 400; a planned
    // relay is a 200 carrying the honest "assembled but not broadcast" note.
    return send(res, outcome.status === "planned" ? 200 : 400, outcome);
  }

  // The origin chains a cross-chain deposit can be priced from. Static, so the
  // console can render the chooser without a network round trip.
  if (method === "GET" && url.pathname === "/v1/funding/chains") {
    return send(res, 200, FUNDING_CHAINS.map(({ chain, asset, symbol, label }) => ({ chain, asset, symbol, label })));
  }

  // Price a cross-chain deposit into the treasury with a real 1Click dry quote.
  // This is the only Intents path that is live (no partner key, no funds at
  // risk); it returns a price and a fee and never a deposit address, so the
  // simulated funding card can show a real number without implying money moves.
  if (method === "POST" && url.pathname === "/v1/funding/quote") {
    if (!deps.live) return send(res, 400, { error: "live services not configured" });
    const body = (await readJson(req)) as { chain?: string; usdCents?: number; recipient?: string };
    if (!body.chain) return send(res, 400, { error: "chain is required" });
    if (typeof body.usdCents !== "number" || !Number.isFinite(body.usdCents) || body.usdCents <= 0) {
      return send(res, 400, { error: "usdCents must be a positive number" });
    }
    const recipient = body.recipient ?? deps.testnet?.account;
    if (!recipient) return send(res, 400, { error: "recipient is required" });
    try {
      const quote = await deps.live.fundingQuote({
        chain: body.chain,
        amountUsdCents: Math.round(body.usdCents),
        recipient,
      });
      return send(res, 200, {
        simulated: true,
        chain: quote.chain,
        origin: quote.origin,
        destination: quote.destination,
        recipient,
        preview: quote.preview,
        note:
          "Live 1Click price. No deposit address is issued and nothing moves: " +
          "NEAR Intents and 1Click have no testnet, so this funds mainnet only.",
      });
    } catch (err) {
      return send(res, 502, { error: err instanceof Error ? err.message : "quote failed" });
    }
  }

  if (method === "GET" && url.pathname === "/v1/approvals") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const status = url.searchParams.get("status");
    const all = [...store.approvals.values()].filter(
      (a) => a.orgId === orgId && (!status || a.status === status),
    );
    return send(res, 200, all);
  }

  const decisionMatch = /^\/v1\/approvals\/([^/]+)\/(approve|reject|execute)$/.exec(url.pathname);
  if (method === "POST" && decisionMatch) {
    const [, id, action] = decisionMatch;
    const approval = store.approvals.get(id!);
    // Approving, rejecting and executing all move or authorise money. An
    // approval belonging to another org is treated as absent so its id cannot
    // be probed, and so this cannot be used to release someone else's funds.
    if (!approval || approval.orgId !== access.principal.orgId) {
      return send(res, 404, { error: "approval not found" });
    }

    if (action === "approve" || action === "reject") {
      // Only a pending approval can be decided; a second decision is a
      // conflict, not a no-op, so a lost response cannot flip an outcome.
      if (approval.status !== "pending") {
        return send(res, 409, { error: `approval is ${approval.status}, not pending` });
      }
      const body = (await readJson(req)) as { decidedBy?: string; note?: string };
      const decided: Approval = {
        ...approval,
        status: action === "approve" ? "approved" : "rejected",
        decidedBy: body.decidedBy ?? "unknown",
        decidedAt: new Date().toISOString(),
        ...(body.note ? { note: body.note } : {}),
      };
      store.approvals.set(approval.id, decided);
      notify(store, {
        orgId: approval.orgId,
        kind: "approval_decided",
        to: approval.payeeId,
        refType: "approval",
        refId: approval.id,
        message: `approval ${approval.id} ${action === "approve" ? "approved" : "rejected"} by ${body.decidedBy ?? "unknown"}`,
      });
      return send(res, 200, decided);
    }

    // execute: requires an approval, and re-checks the current policy.
    if (approval.status !== "approved") {
      return send(res, 409, { error: `approval is ${approval.status}, not approved` });
    }
    const policy = activePolicy(store, approval.orgId);
    if (!policy) return send(res, 400, { error: "no active policy for org" });

    const result = await executeApproved(approval, {
      policy,
      rail: deps.rail,
      ...(deps.signer ? { signer: deps.signer } : {}),
      lookupPayee: (payeeId) => store.payees.get(payeeId),
      payeeHasHistory: (payeeId) => (store.payeeHistory.get(payeeId) ?? 0) > 0,
      spentTodayCents: store.settledTodayCents.get(approval.orgId) ?? 0,
    });

    store.approvals.set(approval.id, result.approval);
    // Record the funding handle whether the operation executed or not: a
    // failed or unresolved funding is exactly the case that must be kept. The
    // quote travels with it so a later resolve can ask the rail for the truth.
    recordFunding(
      store,
      {
        orgId: approval.orgId,
        operationId: approval.operationId,
        payeeId: approval.payeeId,
        ...(result.quote ? { railQuote: result.quote } : {}),
      },
      result.funding,
    );
    if (result.status === "executed") {
      store.payeeHistory.set(approval.payeeId, (store.payeeHistory.get(approval.payeeId) ?? 0) + 1);
      store.settledTodayCents.set(
        approval.orgId,
        (store.settledTodayCents.get(approval.orgId) ?? 0) + approval.operation.usdCents,
      );
      if (result.journal) store.journalEntries.push(result.journal);
    }

    // The loop moved: carry the outcome into the read model (line state,
    // decision record, receipt) and tell the audience.
    const prior = store.operationRecords.get(approval.operationId);
    const base = {
      orgId: approval.orgId,
      operationId: approval.operationId,
      payeeId: approval.payeeId,
      ...(prior?.payRunId ? { payRunId: prior.payRunId } : {}),
      decision: prior?.decision ?? ("allow_with_approval" as const),
      reasonCodes: prior?.reasonCodes ?? approval.reasonCodes,
      policyId: prior?.policyId ?? approval.policyId,
      policyVersion: prior?.policyVersion ?? approval.policyVersion,
    };
    if (result.status === "executed" && result.journal) {
      recordOutcome(store, {
        ...base,
        status: "settled",
        ...(result.settlement?.quoteId ? { quoteId: result.settlement.quoteId } : {}),
        ...(result.settlement?.txHash ? { txHash: result.settlement.txHash } : {}),
        ...(result.settlement?.evidence ? { evidence: result.settlement.evidence } : {}),
        journalEntryId: result.journal.id,
      });
      notify(store, {
        orgId: approval.orgId,
        kind: "payee_paid",
        to: approval.payeeId,
        refType: "approval",
        refId: approval.id,
        message: `paid ${approval.payeeId} (approval ${approval.id})`,
      });
    } else if (result.status === "failed") {
      const reason = result.approval.note ?? "execution failed";
      recordOutcome(store, { ...base, status: "failed", note: reason });
      notify(store, {
        orgId: approval.orgId,
        kind: "payout_failed",
        to: "owner",
        refType: "approval",
        refId: approval.id,
        message: `payout ${approval.operationId} failed: ${reason}`,
      });
    } else if (result.status === "needs_review") {
      const reason =
        result.funding && "reason" in result.funding ? result.funding.reason : "execution unresolved";
      recordOutcome(store, { ...base, status: "submitted", note: reason });
      notify(store, {
        orgId: approval.orgId,
        kind: "payout_needs_review",
        to: "owner",
        refType: "approval",
        refId: approval.id,
        message: `payout ${approval.operationId} needs review: ${reason}`,
      });
    } else {
      recordOutcome(store, {
        orgId: approval.orgId,
        operationId: approval.operationId,
        payeeId: approval.payeeId,
        ...(prior?.payRunId ? { payRunId: prior.payRunId } : {}),
        decision: "deny",
        reasonCodes: result.reasons ?? [],
        policyId: policy.id,
        policyVersion: policy.version,
        status: "denied",
        note: "stale: policy now denies this operation",
      });
      notify(store, {
        orgId: approval.orgId,
        kind: "payee_denied",
        to: approval.payeeId,
        refType: "approval",
        refId: approval.id,
        message: `approval ${approval.id} went stale: policy now denies this operation`,
      });
    }

    const status = result.status === "executed" ? 200 : 409;
    return send(res, status, {
      status: result.status,
      approval: result.approval,
      ...(result.reasons ? { reasons: result.reasons } : {}),
    });
  }

  if (method === "POST" && url.pathname === "/v1/agent-tasks") {
    if (!deps.agentpay) return send(res, 400, { error: "no agentpay client configured" });
    const body = (await readJson(req)) as {
      id?: string;
      orgId?: string;
      payeeId: string;
      resourceUrl: string;
      /** Destination base units the agent must receive. */
      amountOut: string | number;
      usdCents: UsdCents;
      description?: string;
      externalId?: string;
    };
    const orgId = access.org(body.orgId);
    if (!orgId) return notFound(res);
    const payee = store.payees.get(body.payeeId);
    // The payee must belong to the caller's org too, or this would pay someone
    // else's contractor out of the caller's books.
    if (!payee || payee.orgId !== orgId) {
      return send(res, 400, { error: `unknown payee ${body.payeeId}` });
    }
    const policy = activePolicy(store, orgId);
    if (!policy) return send(res, 400, { error: "no active policy for org" });

    const taskId = body.id ?? `task_${store.agentTasks.size + 1}`;
    const task: AgentTask = {
      id: taskId,
      orgId,
      payeeId: body.payeeId,
      protocol: "x402",
      resourceUrl: body.resourceUrl,
      amountOut: BigInt(body.amountOut),
      usdCents: body.usdCents,
      destination: payee.destination,
      ...(body.description ? { description: body.description } : {}),
      ...(body.externalId ? { externalId: body.externalId } : {}),
      status: "open",
      createdAt: new Date().toISOString(),
    };
    store.agentTasks.set(task.id, task);

    const outcome = await payAgentTask(task, policy, {
      agentpay: deps.agentpay,
      ...(deps.signer ? { signer: deps.signer } : {}),
      lookupPayee: (id) => store.payees.get(id),
      payeeHasHistory: (id) => (store.payeeHistory.get(id) ?? 0) > 0,
      spentTodayCents: store.settledTodayCents.get(orgId) ?? 0,
    });

    // A denial is recorded as a failed task so nothing downstream mistakes it
    // for something that could still pay; a held-back payout keeps its own
    // status, because it is waiting on a human, not on a retry.
    const status: AgentTask["status"] = outcome.status === "denied" ? "failed" : outcome.status;
    const updated: AgentTask = {
      ...task,
      status,
      ...(outcome.status === "paid" ? { receipt: outcome.receipt } : {}),
      ...("reason" in outcome ? { note: outcome.reason } : {}),
    };
    store.agentTasks.set(task.id, updated);

    // Keep the funding handle when the payout did not fully resolve. An agent
    // task settles through the x402 facilitator, so the record says so — the
    // 1Click rail knows nothing about this deposit address.
    recordFunding(
      store,
      { orgId: task.orgId, operationId: task.id, payeeId: task.payeeId, settlesVia: "agentpay" },
      "funding" in outcome ? outcome.funding : undefined,
    );

    if (outcome.status === "paid") {
      store.payeeHistory.set(task.payeeId, (store.payeeHistory.get(task.payeeId) ?? 0) + 1);
      store.settledTodayCents.set(
        task.orgId,
        (store.settledTodayCents.get(task.orgId) ?? 0) + task.usdCents,
      );
      store.journalEntries.push(outcome.journal);
    }

    const code = outcome.status === "paid" ? 201 : outcome.status === "awaiting_approval" ? 202 : 409;
    return send(res, code, {
      task: updated,
      status: outcome.status,
      ...(outcome.status === "paid" ? { journal: outcome.journal } : {}),
      ...(outcome.status === "denied" || outcome.status === "awaiting_approval"
        ? { reasons: outcome.decision.reasons.map((r) => r.code) }
        : {}),
      ...(outcome.status === "failed" || outcome.status === "needs_review" ? { reason: outcome.reason } : {}),
    });
  }

  if (method === "GET" && url.pathname === "/v1/agent-tasks") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const all = [...store.agentTasks.values()].filter((t) => t.orgId === orgId);
    return send(res, 200, all);
  }

  if (method === "GET" && url.pathname === "/v1/exports/agent-payments") {
    // A 1099-style roll-up: what each agent payee was paid in a tax year, with
    // the terminal receipt for each payment so a figure can be traced to a
    // transaction rather than taken on trust.
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const year = url.searchParams.get("year") ?? String(new Date().getUTCFullYear());

    const rows = new Map<
      string,
      { payeeId: string; displayName: string; totalBaseUnits: bigint; totalUsdCents: number; payments: number }
    >();
    for (const task of store.agentTasks.values()) {
      if (task.orgId !== orgId || task.status !== "paid" || !task.receipt) continue;
      if (!task.receipt.settledAt.startsWith(year)) continue;
      const payee = store.payees.get(task.payeeId);
      const row = rows.get(task.payeeId) ?? {
        payeeId: task.payeeId,
        displayName: payee?.displayName ?? task.payeeId,
        totalBaseUnits: 0n,
        totalUsdCents: 0,
        payments: 0,
      };
      row.totalBaseUnits += task.receipt.amountIn;
      row.totalUsdCents += task.usdCents;
      row.payments += 1;
      rows.set(task.payeeId, row);
    }

    const report = [...rows.values()]
      .sort((a, b) => b.totalUsdCents - a.totalUsdCents)
      .map((r) => ({
        payeeId: r.payeeId,
        displayName: r.displayName,
        totalBaseUnits: r.totalBaseUnits.toString(),
        totalUsdCents: r.totalUsdCents,
        totalUsd: (r.totalUsdCents / 100).toFixed(2),
        payments: r.payments,
        // 1099-NEC reporting threshold for a non-employee, in cents.
        meetsReportingThreshold: r.totalUsdCents >= 60_000,
      }));

    return send(res, 200, { orgId, year, currency: "usd", rows: report });
  }

  if (method === "GET" && url.pathname === "/v1/ledger") {
    // The books, plus the two things that make them checkable: a trial balance
    // that must net to zero per currency, and a content hash that pins the
    // export to an exact set of entries.
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const entries = store.journalEntries.filter((e) => e.orgId === orgId);

    // An entry that does not balance is a bug, not a report. Refuse rather than
    // hand back books we cannot vouch for.
    if (!allBalanced(entries)) {
      return send(res, 500, { error: "ledger contains an unbalanced entry; export refused" });
    }

    const balance = trialBalance(entries);
    return send(res, 200, {
      orgId,
      entries: entries.map((e) => ({
        ...e,
        postings: e.postings.map((p) => ({ ...p, amount: p.amount.toString() })),
      })),
      trialBalance: balance.rows,
      balanced: balance.balanced,
      ...(balance.balanced ? {} : { unbalancedCurrencies: balance.unbalancedCurrencies }),
      attestation: attestation(entries),
      entryCount: entries.length,
    });
  }

  // The books as a CSV an accountant can open in a spreadsheet: one row per
  // posting, so a figure can be filtered by account, currency, or date. Amounts
  // are written as exact base-unit integers (never floats) with the currency
  // beside them, and the memo carries the source reference.
  if (method === "GET" && url.pathname === "/v1/exports/journal.csv") {
    const orgId = access.org(url.searchParams.get("orgId"));
    if (!orgId) return notFound(res);
    const entries = store.journalEntries.filter((e) => e.orgId === orgId);
    if (!allBalanced(entries)) {
      return send(res, 500, { error: "ledger contains an unbalanced entry; export refused" });
    }
    const rows: string[][] = [["date", "entry_id", "kind", "memo", "account", "direction", "amount", "currency"]];
    for (const entry of entries) {
      for (const p of entry.postings) {
        rows.push([
          entry.createdAt,
          entry.id,
          entry.kind,
          entry.memo,
          p.account,
          p.direction,
          p.amount.toString(),
          p.currency,
        ]);
      }
    }
    return sendCsv(res, "crewpay-journal.csv", rows);
  }

  return send(res, 404, { error: "not found" });
}

/**
 * The public, capability-URL view of one invoice. Deliberately narrow: the
 * amount, what it is for, and whether it is already settled. No customer id, no
 * org id, no other invoice. A link that leaks exposes one obligation, not a
 * ledger.
 */
function publicInvoiceView(
  res: ServerResponse,
  store: Store,
  deps: ApiDeps,
  invoiceId: string,
): void {
  const invoice = store.invoices.get(invoiceId);
  if (!invoice) return notFound(res);
  const payment = store.invoicePayments.get(invoiceId);
  return send(res, 200, {
    id: invoice.id,
    amount: invoice.amount,
    currency: "USD",
    lineItems: invoice.lineItems ?? [],
    ...(invoice.dueDate ? { dueDate: invoice.dueDate } : {}),
    status: invoice.status,
    settlementAsset: invoice.settlementAsset,
    ...(invoice.txHashes && invoice.txHashes.length > 0 ? { txHashes: invoice.txHashes } : {}),
    ...(invoice.paidAt ? { paidAt: invoice.paidAt } : {}),
    // The chains the customer can pay from. Every one is a real 1Click corridor
    // into our NEAR settlement asset, so the list is not decorative.
    supportedChains: FUNDING_CHAINS.map((c) => ({ chain: c.chain, label: c.label, symbol: c.symbol })),
    // How to pay from a chain of the customer's choosing, if a session exists.
    ...(payment
      ? {
          payment: {
            originChain: payment.originChain,
            destinationChain: payment.destinationChain,
            destinationAsset: payment.destinationAsset,
            depositAddress: payment.depositAddress,
            ...(payment.depositMemo ? { depositMemo: payment.depositMemo } : {}),
            amountOut: payment.amountOut,
            deadline: payment.deadline,
            lastStatus: payment.lastStatus ?? "PENDING_DEPOSIT",
          },
        }
      : {}),
  });
}

/**
 * The customer's payment status. Re-reads 1Click by the deposit address (the
 * same "the webhook is a claim, the API is truth" rule the Ping webhook uses),
 * applies a settlement to the invoice exactly once, and reports back.
 */
async function publicInvoiceStatus(
  res: ServerResponse,
  store: Store,
  deps: ApiDeps,
  invoiceId: string,
): Promise<void> {
  const invoice = store.invoices.get(invoiceId);
  if (!invoice) return notFound(res);
  const payment = store.invoicePayments.get(invoiceId);
  if (!payment || !deps.live) {
    return send(res, 200, { status: invoice.status, settled: invoice.status === "paid" });
  }

  let read: { status: string; raw: string; txHashes: readonly string[]; refundReason?: string };
  try {
    read = await deps.live.paymentStatus({
      depositAddress: payment.depositAddress,
      ...(payment.depositMemo ? { depositMemo: payment.depositMemo } : {}),
    });
  } catch {
    // 1Click has not seen the deposit address yet, or is briefly unreachable.
    // Report the last known state rather than inventing a failure.
    return send(res, 200, { status: invoice.status, rail: payment.lastStatus ?? "PENDING_DEPOSIT" });
  }

  payment.lastStatus = read.raw;

  // Apply once. A re-read after settlement must not re-open the pay run.
  if (!payment.settled && read.status === "settled") {
    payment.settled = true;
    const updated: Invoice = {
      ...invoice,
      status: "paid",
      paidAt: new Date().toISOString(),
      ...(read.txHashes.length > 0 ? { txHashes: read.txHashes } : {}),
    };
    store.invoices.set(invoice.id, updated);
    store.invoicePayments.set(invoiceId, payment);

    // A paid invoice opens the pay run through the same policy path as any run.
    const auto = store.invoicePayRuns.get(invoice.id);
    if (auto) {
      await createPayRun(store, deps, {
        orgId: invoice.orgId,
        period: new Date().toISOString().slice(0, 7),
        source: "invoice",
        sourceRef: invoice.id,
        origin: auto.origin ?? invoice.settlementAsset,
        lines: [{ payeeId: auto.payeeId, usdCents: invoice.amount }],
      });
    }
    return send(res, 200, { status: "paid", rail: read.raw, txHashes: read.txHashes, settled: true });
  }

  if (!payment.settled && read.status === "refunded") {
    const updated: Invoice = {
      ...invoice,
      status: "refunded",
      ...(read.refundReason ? { refundReason: read.refundReason } : {}),
    };
    store.invoices.set(invoice.id, updated);
  }

  store.invoicePayments.set(invoiceId, payment);
  return send(res, 200, {
    status: store.invoices.get(invoice.id)?.status ?? invoice.status,
    rail: read.raw,
    txHashes: read.txHashes,
    settled: payment.settled,
  });
}

/**
 * Open a payment session for an invoice: price the corridor from the customer's
 * chosen chain into our NEAR settlement asset and mint a 1Click deposit address.
 * This is a real 1Click quote — the address is live and settles to us — so it is
 * rate-limited per invoice and refused once the invoice is paid.
 */
async function publicInvoiceQuote(
  res: ServerResponse,
  store: Store,
  deps: ApiDeps,
  invoiceId: string,
  body: { originChain?: string; amountUsdCents?: number },
): Promise<void> {
  const invoice = store.invoices.get(invoiceId);
  if (!invoice) return notFound(res);
  if (invoice.status === "paid") return send(res, 409, { error: "invoice already paid" });
  if (!deps.live) return send(res, 400, { error: "live payment services not configured" });
  const recipient = deps.testnet?.account;
  if (!recipient) return send(res, 400, { error: "no settlement account configured" });
  const originChain = (body.originChain ?? "").trim();
  if (!originChain) return send(res, 400, { error: "originChain is required" });

  // An existing session that has not expired and matches the chain is reused, so
  // refreshing the page does not mint a new address (and a new obligation) each
  // time. A different chain, or an expired address, re-quotes.
  const existing = store.invoicePayments.get(invoiceId);
  const stillLive = existing && Date.parse(existing.deadline) > Date.now() + 60_000;
  if (existing && stillLive && existing.originChain === originChain) {
    return send(res, 200, {
      reused: true,
      originChain: existing.originChain,
      destinationChain: existing.destinationChain,
      destinationAsset: existing.destinationAsset,
      depositAddress: existing.depositAddress,
      ...(existing.depositMemo ? { depositMemo: existing.depositMemo } : {}),
      amountOut: existing.amountOut,
      deadline: existing.deadline,
      correlationId: existing.correlationId,
    });
  }

  const amountUsdCents = body.amountUsdCents ?? invoice.amount;
  if (amountUsdCents !== invoice.amount) {
    return send(res, 400, { error: "amount must equal the invoice total" });
  }

  try {
    const { quote, chain } = await deps.live.paymentQuote({ originChain, amountUsdCents, recipient });
    const payment: InvoicePayment = {
      invoiceId,
      originChain: chain.chain,
      destinationChain: "near",
      destinationAsset: "usdt",
      recipient,
      amountOut: quote.amountOut,
      depositAddress: quote.depositAddress,
      ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
      deadline: quote.deadline,
      correlationId: quote.correlationId,
      createdAt: new Date().toISOString(),
      settled: false,
      lastStatus: "PENDING_DEPOSIT",
    };
    store.invoicePayments.set(invoiceId, payment);
    return send(res, 200, {
      reused: false,
      originChain: payment.originChain,
      destinationChain: payment.destinationChain,
      destinationAsset: payment.destinationAsset,
      depositAddress: payment.depositAddress,
      ...(payment.depositMemo ? { depositMemo: payment.depositMemo } : {}),
      amountIn: quote.amountIn,
      ...(quote.amountInFormatted ? { amountInFormatted: quote.amountInFormatted } : {}),
      amountOut: quote.amountOut,
      ...(quote.amountOutFormatted ? { amountOutFormatted: quote.amountOutFormatted } : {}),
      ...(typeof quote.timeEstimate === "number" ? { timeEstimate: quote.timeEstimate } : {}),
      deadline: payment.deadline,
      correlationId: payment.correlationId,
    });
  } catch (err) {
    return send(res, 502, { error: err instanceof Error ? err.message : "quote failed" });
  }
}

/**
 * Ping's webhook. Public by necessity: Ping cannot present a bearer token,
 * so this is authenticated by the HMAC over the raw body instead. A bad
 * signature throws out of `verifyWebhook` and becomes a 500 — never a 2xx,
 * which would tell Ping the event was handled.
 */
async function handlePingWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  deps: ApiDeps,
): Promise<void> {
  if (!deps.pingpay) return send(res, 400, { error: "no pingpay client configured" });
  // The raw body is what the signature covers. Re-serialising parsed JSON
  // would change whitespace and key order and break the HMAC.
  const raw = await readRaw(req);
  const event = deps.pingpay.verifyWebhook(raw, {
    ...(typeof req.headers["x-ping-signature"] === "string"
      ? { signature: req.headers["x-ping-signature"] }
      : {}),
    ...(typeof req.headers["x-ping-timestamp"] === "string"
      ? { timestamp: req.headers["x-ping-timestamp"] }
      : {}),
  }) as unknown as PingWebhookEvent;

  // Ping retries until it gets a 2xx, so the same event can arrive twice.
  // Acknowledging a duplicate without acting is what makes that safe.
  if (store.webhookEvents.has(event.id)) {
    return send(res, 200, { received: true, duplicate: true, eventId: event.id });
  }
  store.webhookEvents.set(event.id, { type: event.type, at: new Date().toISOString() });

  const invoice = [...store.invoices.values()].find(
    (i) => i.checkoutSessionId === event.resourceId || i.paymentId === event.resourceId,
  );
  if (!invoice) {
    // Nothing of ours matches. Acknowledge so Ping stops retrying, but say so.
    return send(res, 200, { received: true, matched: false, eventId: event.id });
  }

  if (event.type === "checkout.session.completed") {
    // The webhook is a claim; the session is the truth. Ask Ping before
    // releasing money, so a forged-but-signed-elsewhere or replayed event
    // cannot mark an unpaid invoice as paid.
    const session = await deps.pingpay.getCheckout(invoice.checkoutSessionId);
    const status = invoiceStatusFor(session.status);
    const txHashes = extractTxHashes(event.data);
    const updated: Invoice = {
      ...invoice,
      status,
      ...(session.paymentId ? { paymentId: session.paymentId } : {}),
      ...(txHashes.length > 0 ? { txHashes } : {}),
      ...(status === "paid" ? { paidAt: new Date().toISOString() } : {}),
    };
    store.invoices.set(invoice.id, updated);

    if (status !== "paid") {
      return send(res, 200, { received: true, invoice: updated, note: "session not completed at Ping" });
    }

    const auto = store.invoicePayRuns.get(invoice.id);
    if (!auto) return send(res, 200, { received: true, invoice: updated });

    // Paid: open the pay run that pays the contractor out of the proceeds.
    const payRun = await createPayRun(store, deps, {
      orgId: invoice.orgId,
      period: new Date().toISOString().slice(0, 7),
      source: "invoice",
      sourceRef: invoice.id,
      origin: auto.origin ?? invoice.settlementAsset,
      lines: [{ payeeId: auto.payeeId, usdCents: invoice.amount }],
    });
    return send(res, 200, { received: true, invoice: updated, payRun });
  }

  // A payment that is in flight but not final: `pending`, not `paid`. The
  // distinction is the whole point — an operator must not treat "sent" as
  // "cleared", and a pay run is never released on a pending payment.
  if (event.type === "payment.pending") {
    const txHashes = extractTxHashes(event.data);
    const updated: Invoice = {
      ...invoice,
      status: "pending",
      ...(txHashes.length > 0 ? { txHashes } : {}),
    };
    store.invoices.set(invoice.id, updated);
    return send(res, 200, { received: true, invoice: updated });
  }

  if (event.type === "payment.success") {
    // Re-read the payment before releasing: the event is a claim.
    const payment = invoice.paymentId ? await deps.pingpay.getPayment?.(invoice.paymentId) : undefined;
    const status = payment ? invoiceStatusForPayment(payment.status) : "paid";
    const txHashes = extractTxHashes(event.data);
    const updated: Invoice = {
      ...invoice,
      status,
      ...(txHashes.length > 0 ? { txHashes } : {}),
      ...(status === "paid" ? { paidAt: new Date().toISOString() } : {}),
    };
    store.invoices.set(invoice.id, updated);
    return send(res, 200, { received: true, invoice: updated });
  }

  if (event.type === "checkout.session.expired" || event.type === "payment.failed") {
    const status: InvoiceStatus = event.type === "payment.failed" ? "failed" : "expired";
    const updated: Invoice = { ...invoice, status };
    store.invoices.set(invoice.id, updated);
    return send(res, 200, { received: true, invoice: updated });
  }

  return send(res, 200, { received: true, ignored: event.type, eventId: event.id });
}

/**
 * Pull transaction hashes out of a Ping webhook's free-form `data` bag. Ping
 * documents `data` as "anything", so this accepts the plausible spellings and
 * returns nothing when it finds none — an invoice with no traceable tx is
 * honest; a fabricated one is not.
 */
function extractTxHashes(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) for (const item of v) push(item);
  };
  for (const key of ["txHash", "tx_hash", "transactionHash", "transaction_hash", "hash", "txHashes", "hashes"]) {
    if (key in data) push(data[key]);
  }
  return [...new Set(out)];
}
