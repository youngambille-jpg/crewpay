import { SignerError } from "./signer.ts";

/**
 * Statuses a request row can hold, exactly as the service emits them. Do not
 * widen this set: inventing synonyms like `settled` or `completed` gives false
 * confidence and hides `needs_review`, which is the one that matters.
 */
export type OutLayerStatus =
  | "processing"
  | "success"
  | "failed"
  | "needs_review"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "pending_deposit"
  | "refunded"
  | "partially_failed";

export interface OutLayerRequestRow {
  readonly request_id: string;
  readonly type?: string;
  readonly status: OutLayerStatus | string;
  readonly poll_url?: string;
  /** Chain tx for wallet ops (`/transfer`, `/call`): top-level, per the skill. */
  readonly tx_hash?: string;
  readonly result?: Record<string, unknown> | null;
}

/**
 * One multisig approval waiting on the wallet. OutLayer keeps these beside the
 * request they gate: the request is `pending_approval` until the ballot passes
 * its threshold, and settles only when a human votes. Polling the request will
 * never move it, which is why this is read separately.
 */
export interface OutLayerApproval {
  readonly approval_id: string;
  readonly request_id?: string;
  readonly status?: string;
  readonly type?: string;
  readonly created_at?: string;
}

export interface OutLayerClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Ask the service to answer within this many seconds instead of blocking. */
  readonly answerWithinSeconds?: number;
}

/** A failure that never reached the service, so nothing moved and a resend is safe. */
export class TransportError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TransportError";
    this.cause = cause;
  }
}

interface RawResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Thin client for the OutLayer wallet API. It exists to keep three things in
 * one place, because getting any of them wrong moves money twice:
 *
 * 1. Idempotency. Every state-changing call carries `X-Idempotency-Key`, and a
 *    repeated key comes back as HTTP 200 with `error: duplicate_idempotency_key`
 *    rather than a 4xx, so it is detected explicitly and read for its request.
 * 2. Bounded waits. `X-Answer-Within` makes a slow settlement answer with a
 *    request id to poll instead of holding the connection until it times out.
 * 3. Error shape. 4xx bodies are `{error, message}`; those become `SignerError`.
 */
export class OutLayerClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly apiKey: string;
  private readonly answerWithinSeconds: number;

  constructor(cfg: OutLayerClientConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? "https://api.outlayer.ai").replace(/\/$/, "");
    this.fetch = cfg.fetchImpl ?? globalThis.fetch;
    this.answerWithinSeconds = cfg.answerWithinSeconds ?? 20;
  }

  /** The wallet's NEAR address, which is also the sender on on-chain transfers. */
  async address(): Promise<{ address: string; publicKey?: string }> {
    const res = await this.send("GET", "/wallet/v1/address?chain=near");
    return {
      address: String(res.body["address"] ?? ""),
      ...(res.body["public_key"] ? { publicKey: String(res.body["public_key"]) } : {}),
    };
  }

  async balance(token: string, source?: "intents"): Promise<bigint> {
    const params = new URLSearchParams({ token });
    if (source) params.set("source", source);
    const res = await this.send("GET", `/wallet/v1/balance?${params.toString()}`);
    return BigInt(String(res.body["balance"] ?? "0"));
  }

  /** On-chain native NEAR transfer. Needs the wallet to hold NEAR for gas. */
  async transferNear(to: string, amount: string, key: string): Promise<OutLayerRequestRow> {
    return this.mutate("/wallet/v1/transfer", { chain: "near", to, amount }, key);
  }

  /** On-chain NEP-141 transfer, optionally carrying a memo as `msg`. */
  async ftTransfer(
    token: string,
    to: string,
    amount: string,
    key: string,
    memo?: string,
  ): Promise<OutLayerRequestRow> {
    const args: Record<string, string> = { receiver_id: to, amount };
    if (memo) args["msg"] = memo;
    return this.callContract(token, "ft_transfer", args, key);
  }

  /**
   * Call any method on any contract from the wallet's account. This is the
   * escape hatch ft_transfer is built on: storage deposits and testnet minting
   * go through here. `deposit` is yoctoNEAR attached to the call.
   */
  async callContract(
    receiver: string,
    method: string,
    args: Record<string, unknown>,
    key: string,
    opts?: { gas?: string; deposit?: string },
  ): Promise<OutLayerRequestRow> {
    return this.mutate(
      "/wallet/v1/call",
      {
        receiver_id: receiver,
        method_name: method,
        args,
        gas: opts?.gas ?? "30000000000000",
        deposit: opts?.deposit ?? "1",
      },
      key,
    );
  }

  /** Gasless NEAR Intents withdraw, delivering to `to` on `chain`. */
  async intentsWithdraw(
    to: string,
    amount: string,
    token: string,
    chain: string,
    key: string,
  ): Promise<OutLayerRequestRow> {
    return this.mutate(
      "/wallet/v1/intents/withdraw",
      { to, amount, token, chain, async: true },
      key,
    );
  }

  async getRequest(id: string): Promise<OutLayerRequestRow> {
    const res = await this.send("GET", `/wallet/v1/requests/${encodeURIComponent(id)}`);
    return res.body as unknown as OutLayerRequestRow;
  }

  /**
   * Read the wallet's effective policy. This is the policy the TEE enforces,
   * which is authored by the wallet's owner rather than by us, so it is read
   * and diffed rather than assumed.
   */
  async getPolicy(): Promise<Record<string, unknown>> {
    const res = await this.send("GET", "/wallet/v1/policy");
    return res.body;
  }

  /**
   * The wallet's open multisig approvals. A `pending_approval` request settles
   * only when a human votes, so this is how an operation stuck in that state is
   * found. The dashboard route (`pending_approvals_by_pubkey`) needs an owner
   * session; this one takes the wallet's own `wk_` key.
   */
  async pendingApprovals(): Promise<readonly OutLayerApproval[]> {
    const res = await this.send("GET", "/wallet/v1/pending_approvals");
    const rows = Array.isArray(res.body) ? res.body : (res.body["approvals"] as unknown[]) ?? [];
    return rows as unknown as readonly OutLayerApproval[];
  }

  /** Read one approval by id. This route needs no owner session. */
  async getApproval(id: string): Promise<OutLayerApproval> {
    const res = await this.send("GET", `/wallet/v1/approval/${encodeURIComponent(id)}`);
    return res.body as unknown as OutLayerApproval;
  }

  /**
   * POST a state-changing call. A `duplicate_idempotency_key` response is not an
   * error: it names the request the key already reserved, so it is returned like
   * any other row and the caller polls that instead of sending again.
   */
  private async mutate(
    path: string,
    body: Record<string, unknown>,
    key: string,
  ): Promise<OutLayerRequestRow> {
    const res = await this.send("POST", path, body, key);
    return res.body as unknown as OutLayerRequestRow;
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
    if (body) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
    if (body) headers["X-Answer-Within"] = String(this.answerWithinSeconds);

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      // Never reached the service, so no funds moved and a resend is safe.
      throw new TransportError(`outlayer ${method} ${path} failed`, cause);
    }

    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { message: text };
      }
    }

    // A duplicate key arrives as 200 with an error field; return it as a row.
    if (parsed["error"] === "duplicate_idempotency_key") {
      return { status: 200, body: parsed };
    }

    if (!res.ok) {
      const code = String(parsed["error"] ?? `http_${res.status}`);
      const message = String(parsed["message"] ?? res.statusText ?? code);
      throw new SignerError("outlayer", res.status, code, message);
    }

    return { status: res.status, body: parsed };
  }
}

/** True once a request row can no longer change. */
export function isTerminalStatus(status: string): boolean {
  return (
    status === "success" ||
    status === "failed" ||
    status === "needs_review" ||
    status === "rejected" ||
    status === "refunded"
  );
}

/**
 * True while polling could still change the row. `pending_approval` and
 * `approved` are deliberately excluded: a multisig wallet settles those only
 * when a human votes, so polling them would spin until a false escalation.
 */
export function isPollableStatus(status: string): boolean {
  return status === "processing" || status === "pending_deposit";
}
