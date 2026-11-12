import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Operation, PayRunItem, Payee, Policy } from "@crewpay/domain";
import { defaultRules, corridor } from "@crewpay/domain";
import type { SettlementRail } from "@crewpay/rails";
import { executeRun } from "@crewpay/agent";
import { activePolicy, createStore, type Store } from "./store.ts";

export interface ApiDeps {
  readonly rail: SettlementRail;
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
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
    const policy: Policy = {
      id: body.id ?? `pol_${store.policies.size + 1}`,
      orgId: body.orgId,
      version: body.version ?? 1,
      active: body.active ?? true,
      rules: body.rules ?? defaultRules(),
    };
    store.policies.set(policy.id, policy);
    return send(res, 201, policy);
  }

  if (method === "POST" && url.pathname === "/v1/pay-runs") {
    const body = (await readJson(req)) as PayRunRequest;
    const policy = activePolicy(store, body.orgId);
    if (!policy) return send(res, 400, { error: "no active policy for org" });

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
        lookupPayee: (id) => store.payees.get(id),
        payeeHasHistory: (id) => (store.payeeHistory.get(id) ?? 0) > 0,
      },
    );

    for (const outcome of result.outcomes) {
      if (outcome.settlement?.status === "settled") {
        store.payeeHistory.set(outcome.payeeId, (store.payeeHistory.get(outcome.payeeId) ?? 0) + 1);
      }
    }

    const run = {
      id: runId,
      orgId: body.orgId,
      source: "api" as const,
      period: body.period,
      currency: body.currency ?? origin.asset,
      status:
        result.denied.length + result.failed.length === 0 && result.awaitingApproval.length === 0
          ? ("settled" as const)
          : result.settledCents > 0
            ? ("partially_settled" as const)
            : ("awaiting_approval" as const),
      createdBy: "api",
      createdAt: new Date().toISOString(),
    };
    store.payRuns.set(runId, run);
    store.payRunItems.set(runId, items.map((i) => i.item));

    return send(res, 201, {
      run,
      settledCents: result.settledCents,
      awaitingApproval: result.awaitingApproval,
      denied: result.denied,
      failed: result.failed,
      total: total.toString(),
    });
  }

  if (method === "GET" && url.pathname === "/v1/pay-runs") {
    return send(res, 200, [...store.payRuns.values()]);
  }

  return send(res, 404, { error: "not found" });
}
