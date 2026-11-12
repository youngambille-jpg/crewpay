import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  Approval,
  ChainAsset,
  Invoice,
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
import { defaultRules, corridor, invoiceStatusFor } from "@crewpay/domain";
import type { PingPayPort, SettlementRail } from "@crewpay/rails";
import type { Signer } from "@crewpay/signer";
import { compileManifest, diffManifest, type ManifestDrift } from "@crewpay/signer";
import { executeApproved, executeRun } from "@crewpay/agent";
import { activePolicy, createStore, type Store } from "./store.ts";

export interface ApiDeps {
  readonly rail: SettlementRail;
  /** Funds the rail's deposit address. Without it, runs are unfunded. */
  readonly signer?: Signer;
  /** Ping checkout + webhook verification. Without it, invoices are off. */
  readonly pingpay?: PingPayPort;
  readonly store?: Store;
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
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
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
): Promise<Record<string, unknown> | { error: string }> {
  const policy = activePolicy(store, body.orgId);
  if (!policy) return { error: "no active policy for org" };

  const runId = `run_${store.payRuns.size + 1}`;
  const origin = body.origin ?? { chain: "base", asset: "usdc" };
  const items: { item: PayRunItem; operation: Operation }[] = [];
  let total = 0n;

  body.lines.forEach((line, i) => {
    const payee = store.payees.get(line.payeeId);
    if (!payee) throw new Error(`unknown payee ${line.payeeId}`);
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

  const result = await executeRun(
    body.orgId,
    policy,
    items,
    {
      rail: deps.rail,
      ...(deps.signer ? { signer: deps.signer } : {}),
      lookupPayee: (id) => store.payees.get(id),
      payeeHasHistory: (id) => (store.payeeHistory.get(id) ?? 0) > 0,
    },
  );

  for (const outcome of result.outcomes) {
    if (outcome.settlement?.status === "settled") {
      store.payeeHistory.set(outcome.payeeId, (store.payeeHistory.get(outcome.payeeId) ?? 0) + 1);
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
  store.payRunItems.set(runId, items.map((i) => i.item));

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

  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, rail: deps.rail.name });
  }

  if (method === "POST" && url.pathname === "/v1/payees") {
    const body = (await readJson(req)) as Payee;
    store.payees.set(body.id, body);
    if (!store.payeeHistory.has(body.id)) store.payeeHistory.set(body.id, 0);
    return send(res, 201, body);
  }

  if (method === "POST" && url.pathname === "/v1/policies") {
    const body = (await readJson(req)) as Partial<Policy> & { orgId: string };
    const previous = activePolicy(store, body.orgId);
    const policy: Policy = {
      id: body.id ?? `pol_${store.policies.size + 1}`,
      orgId: body.orgId,
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

  if (method === "POST" && url.pathname === "/v1/pay-runs") {
    const body = (await readJson(req)) as PayRunRequest;
    const result = await createPayRun(store, deps, body);
    if ("error" in result) return send(res, 400, result);
    return send(res, 201, result);
  }

  if (method === "POST" && url.pathname === "/v1/invoices") {
    if (!deps.pingpay) return send(res, 400, { error: "no pingpay client configured" });
    const body = (await readJson(req)) as {
      orgId: string;
      customerId: string;
      amount: UsdCents;
      settlementAsset?: ChainAsset;
      successUrl?: string;
      cancelUrl?: string;
      /** Optional: open the pay run the moment the invoice is paid. */
      autoPayRun?: { payeeId: string; origin?: ChainAsset };
    };
    const asset = body.settlementAsset ?? { chain: "near", asset: "usdc" };
    const session = await deps.pingpay.createCheckout({
      amount: body.amount,
      asset,
      ...(body.successUrl ? { successUrl: body.successUrl } : {}),
      ...(body.cancelUrl ? { cancelUrl: body.cancelUrl } : {}),
      customerReference: body.customerId,
    });
    const invoice: Invoice = {
      id: `inv_${store.invoices.size + 1}`,
      orgId: body.orgId,
      customerId: body.customerId,
      amount: body.amount,
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

  if (method === "POST" && url.pathname === "/v1/webhooks/pingpay") {
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
      const updated: Invoice = {
        ...invoice,
        status,
        ...(session.paymentId ? { paymentId: session.paymentId } : {}),
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

    if (event.type === "checkout.session.expired" || event.type === "payment.failed") {
      const status: InvoiceStatus = event.type === "payment.failed" ? "failed" : "expired";
      const updated: Invoice = { ...invoice, status };
      store.invoices.set(invoice.id, updated);
      return send(res, 200, { received: true, invoice: updated });
    }

    return send(res, 200, { received: true, ignored: event.type, eventId: event.id });
  }

  if (method === "GET" && url.pathname === "/v1/invoices") {
    const orgId = url.searchParams.get("orgId");
    const all = [...store.invoices.values()].filter((i) => !orgId || i.orgId === orgId);
    return send(res, 200, all);
  }

  if (method === "GET" && url.pathname === "/v1/pay-runs") {
    return send(res, 200, [...store.payRuns.values()]);
  }

  if (method === "GET" && url.pathname === "/v1/manifest") {
    const orgId = url.searchParams.get("orgId");
    if (!orgId) return send(res, 400, { error: "orgId is required" });
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

  if (method === "GET" && url.pathname === "/v1/approvals") {
    const orgId = url.searchParams.get("orgId");
    const status = url.searchParams.get("status");
    const all = [...store.approvals.values()].filter(
      (a) => (!orgId || a.orgId === orgId) && (!status || a.status === status),
    );
    return send(res, 200, all);
  }

  const decisionMatch = /^\/v1\/approvals\/([^/]+)\/(approve|reject|execute)$/.exec(url.pathname);
  if (method === "POST" && decisionMatch) {
    const [, id, action] = decisionMatch;
    const approval = store.approvals.get(id!);
    if (!approval) return send(res, 404, { error: "approval not found" });

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
    if (result.status === "executed") {
      store.payeeHistory.set(approval.payeeId, (store.payeeHistory.get(approval.payeeId) ?? 0) + 1);
      store.settledTodayCents.set(
        approval.orgId,
        (store.settledTodayCents.get(approval.orgId) ?? 0) + approval.operation.usdCents,
      );
    }

    const status = result.status === "executed" ? 200 : 409;
    return send(res, status, {
      status: result.status,
      approval: result.approval,
      ...(result.reasons ? { reasons: result.reasons } : {}),
    });
  }

  return send(res, 404, { error: "not found" });
}
