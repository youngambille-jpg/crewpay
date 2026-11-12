# AGENTS.md

Repository memory for Crewpay. Read this before making changes.

## What this repo is

Payroll and payouts for the agentic workforce: a policy-guarded agent runs a
company's global pay runs on stablecoin rails (NEAR Intents 1Click, PingPay),
with custody in a TEE (OutLayer). `ARCHITECTURE.md` is the design of record.

## Commands

```bash
npm install       # links workspace packages (npm workspaces)
npm test          # node --test, default discovery
npm run demo      # end-to-end pay run against FakeRail
npm run typecheck # tsc --noEmit, strict
```

There is no build step. There are no runtime dependencies in the core packages.

## Toolchain facts (important)

- **Node >= 22.6 runs `.ts` directly** via native type stripping. We rely on
  this: sources import each other with explicit `.ts` extensions and nothing is
  compiled. Do not add a bundler or ts-node.
- **Strip-only mode forbids enum, namespace, and constructor parameter
  properties.** Use string-literal union types, `as const` objects, and assign
  fields explicitly in the constructor body. `tsc` will not catch this; the
  test runner will.
- **`node --test` with no path arguments** discovers `*.test.ts`. Passing a
  directory path fails with MODULE_NOT_FOUND; pass a file path instead.
- **Workspace packages need an `exports` map** (`{".": "./src/index.ts"}`) or
  Node's ESM resolver falls back to `index.js` and fails. `apps/*` need this too
  if another package imports them.
- The toolchain is offline. `npm install` works from cache; adding a new
  dependency may not. Prefer the standard library.

## Code conventions

- TypeScript, strict, with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`. Optional properties must be built with conditional
  spread (`...(x ? { k: x } : {})`), not assigned `undefined`.
- **Money is never a float.** Amounts are `bigint` in the asset's smallest unit;
  valuations are integer USD cents (`UsdCents`). Policy compares integers only.
- Comments explain non-obvious intent only. Do not narrate the code or the diff.

## Architecture invariants (do not break)

1. **The rails are a commodity; the trust-and-books layer is the product.**
2. **The agent proposes, policy disposes.** Every money movement passes through
   `@crewpay/policy` `evaluate()` before it can be signed. The engine is pure,
   deterministic and stores the policy version with each decision.
3. **No keys in this codebase.** Signing is external (OutLayer TEE).
4. **The ledger is double-entry and enforced.** All entries go through
   `post()`, which throws `UnbalancedEntryError` if debits and credits do not
   match per currency.
5. **Rail specifics stay behind `SettlementRail`.** Money logic must not import
   1Click/PingPay/OutLayer details directly. `FakeRail` keeps the loop testable.

## Layer boundaries

- `packages/domain` — types only, no logic, no dependencies.
- `packages/policy` — pure function `evaluate(op, policy, ctx)`. No I/O.
- `packages/ledger` — pure journal constructors. No I/O.
- `packages/rails` — `SettlementRail` interface + adapters (`FakeRail`,
  `OneClickRail`) and `AssetRegistry`. Network only here.
- `packages/signer` — `Signer` interface + adapters (`FakeSigner`,
  `OutLayerSigner`) and the OutLayer HTTP client. Holds the `wk_` API key;
  never a private key.
- `apps/agent` — orchestration (`executeRun`): policy → signer → rail → ledger.
- `apps/api` — control plane over `node:http`, in-memory store. Owns org state,
  never moves money itself.

## 1Click rail notes

- Spec of record: `https://1click.chaindefuser.com/docs/v0/openapi.yaml`.
  Adapter is written against it; do not guess field names.
- Auth header is `X-API-Key`. Base URL is `https://1click.chaindefuser.com`.
- Quote requires all of: `dry`, `swapType`, `slippageTolerance`, `originAsset`,
  `depositType`, `destinationAsset`, `amount`, `refundTo`, `refundType`,
  `recipient`, `recipientType`, `deadline`. `depositType` is easy to forget.
- Asset ids are not guessable: USDC on NEAR is
  `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`,
  and 1Click lists native NEAR as symbol `wNEAR`. Resolve through
  `AssetRegistry`; never hardcode an id at a call site.
- Run `npm run verify:tokens` after touching `assets.ts`. It checks the pinned
  table against the live `GET /v0/tokens` and fails on drift.
- `EXACT_OUTPUT` means `amount` is the destination amount; `amountIn` comes back
  with a slippage buffer and is refunded if unused.

## OutLayer signer notes

- Skill of record: `https://skills.outlayer.ai/agent-custody/SKILL.md` and its
  `references/` (fetched with curl; the docs site is JS-heavy, the skill files
  are plain Markdown). Base URL `https://api.outlayer.ai`.
- Auth is `Authorization: Bearer wk_...`. There is no `X-API-Key` here — that is
  1Click. Both are live in this repo; do not cross the headers.
- **Funding is not a boolean.** `fund` returns a four-way `FundingOutcome`
  (`deposited` | `pending` | `failed` | `needs_review`). `failed.safeToRetry` is
  true only when the service sets `result.never_executed`/`never_submitted`; a
  bridge failure or refund may otherwise have moved funds. `needs_review` means
  unknown state — escalate, never auto-retry. Retrying unknown state double-pays.
- The terminal status set is exact: `success | failed | needs_review | rejected
  | refunded`. Do not invent `settled`/`completed`/`confirmed`. Poll only
  `processing` and `pending_deposit`; `pending_approval` settles only when a
  human votes, so polling it spins until a false escalation.
- A duplicate idempotency key is HTTP **200** with
  `error: duplicate_idempotency_key`, not a 4xx. Detect it by the body field.
  Keys are scoped to `(wallet, key)` and derived from the operation id, so a
  retry sends the same key. Never reuse one key across two operations.
- On the intents route the real tx is `result.destination_tx_hash` — **not**
  `transfer_intent_hash`/`intent_hash`, which are solver-relay identifiers. On
  the on-chain route it is `result.tx_hash`.
- Two funding routes: `intents` (`POST /wallet/v1/intents/withdraw`, gasless,
  any origin chain) and `onchain` (`POST /wallet/v1/transfer` for native NEAR,
  `POST /wallet/v1/call` with `ft_transfer` for NEP-141). `plan` picks intents
  for non-NEAR origins.
- **Strip-only-mode trap (hit twice now).** Node runs `.ts` by type stripping,
  so TS parameter properties (`constructor(private x: T)`) and `enum` are
  unsupported and throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Declare class
  fields and assign in the body. `tsc` does not catch this — only `npm test`
  does, so run tests, not just `typecheck`.
- A new workspace package needs its `package.json` present **before**
  `npm install`, or npm cannot resolve it and tries the registry (404). After
  adding one, re-run `npm install` to create the `node_modules/@crewpay/*`
  symlink, and confirm `tsc` resolves the import.

## Approval workflow notes

- An approval stores a **frozen copy** of the operation, not a reference. Never
  re-read the operation from the store at execute time — that would let a later
  edit widen what the approver agreed to.
- `executeApproved` re-runs `evaluate()` against the **current** active policy
  before paying. An approval clears the human gate only. If the result is `deny`
  the approval becomes `stale` (HTTP 409) and pays nothing.
- Status is the guard against double payment: only `pending` can be decided,
  only `approved` can execute. `executed`/`rejected`/`stale` are final. A second
  decision is a 409 conflict, not a no-op — do not "fix" this into an idempotent
  200.
- The money path is shared: both `executeRun` and `executeApproved` call
  `settleOperation`. Never add a second funding/submit path; that is how the two
  drift and one loses the double-spend guard.
- Only one policy per org is active. Posting `/v1/policies` deactivates the
  previous version and bumps `version`; `activePolicy()` returns the first match
  and would otherwise keep returning the stale one.

## JSON and money notes

- `bigint` cannot be `JSON.stringify`-ed (`TypeError: Do not know how to
  serialize a BigInt`). The API's `send()` passes a replacer that stringifies
  bigint, so amounts cross the wire as strings. A new response that embeds a raw
  domain object (an `Operation`, say) needs this or it 500s.
- HTTP status conventions in the API: 201 create, 200 ok, 400 bad request, 404
  not found, **409 for a state conflict** (wrong approval status, stale
  approval, failed execution).

## OutLayer custody notes (read from the skill docs, not guessed)

Docs live at `https://skills.outlayer.ai/agent-custody/SKILL.md` plus
`references/*.md` (one file per job; do not read them all). Hosts:
`api.outlayer.ai` (mainnet) and `testnet-api.outlayer.ai` — not `api-testnet.`
or `testnet.api.`, which do not resolve. NEAR Intents do not exist on testnet.

- **Policy is owner-authored, not agent-authored.** There is no agent endpoint
  that writes a wallet policy; the owner sets it in the dashboard
  (`https://app.outlayer.ai/wallet?key={api_key}`). This is deliberate: the party
  being limited must not set the limit. So `compileManifest` is a *proposal* we
  hand the owner, and the agent only reads the effective policy back and diffs.
  Never add a "publish policy" call — it would be inventing an endpoint.
- **Multisig requests never settle by polling.** A request on a multisig wallet
  returns `status: "pending_approval"` and moves only when a human votes. Polling
  it spins until a false escalation — `isPollableStatus` deliberately excludes
  `pending_approval` and `approved` for this reason.
- **Two approval routes, two audiences.** `GET /wallet/v1/pending_approvals`
  takes the wallet's `wk_` key (this is ours). The dashboard route
  `pending_approvals_by_pubkey` needs an owner *session* and answers
  `session_required` for an agent. One approval by id (`approval/{id}`) needs no
  session.
- **Capability toggles are default-DENY.** A wallet that only funds deposits
  needs `intents_withdraw`, `intents_transfer`, `call`. `raw_sign`, `evm_sign`,
  `solana_sign` stay off; `intents_call` is always false — a call to
  `intents.near` can add a key that signs outside the TEE permanently.
- **Multisig limits:** at most 16 approval votes and 16 rejections per signing
  request. A policy with more than 16 approvers can never reach its threshold, so
  `compileManifest` warns above that (`MAX_APPROVERS`).
- `pending_approval` is "not an error"; `needs_review` means fund state is
  UNKNOWN and must not be retried; `rejected` is a terminal failure.

## PingPay notes (read from the docs, not guessed)

Docs: `https://pingpay.gitbook.io/docs/` — every page has a Markdown twin at
the same URL plus `.md`, and `llms.txt` indexes them all. API base:
`https://pay.pingpay.io/api`. Hosted checkout lives at
`https://checkout.pingpay.io/session/{id}`.

- **Two keys, two jobs — never swap them.** Checkout and payment routes take
  `x-publishable-key` (`pk_`, public by design, runs in the browser). The Agent
  Pay facilitator (`/agentpay/x402`, `/agentpay/mpp/charge`) takes `x-api-key`
  and is called server-side. A `pk_` in the agent config is fine; a secret key
  in a browser would not be.
- **The session URL is opaque.** Ping says to use it exactly as returned and not
  to construct it. We store `sessionUrl` verbatim.
- **Webhook signature** is HMAC-SHA256 hex over `${timestamp}.${rawBody}`, sent
  as `x-ping-signature` + `x-ping-timestamp`. Hash the **raw bytes** —
  re-serialising parsed JSON changes whitespace/key order and breaks it. The
  timestamp needs a tolerance window, or a captured event verifies forever.
  Compare timing-safe.
- **Ping retries until 2xx**, so dedupe on the event `id`; a repeat must be
  acknowledged without acting, or a retried `completed` pays twice.
- **The webhook is a claim, the session is the truth.** Verify with
  `GET /checkout/sessions/{id}` before releasing money.
- Session statuses: `CREATED`, `PENDING`, `COMPLETED`, `EXPIRED`, `CANCELLED`.
  Only `COMPLETED` means paid. Payment statuses: `PENDING`, `SUCCESS`, `FAILED`.
- Events: `payment.pending`, `payment.success`, `payment.failed`,
  `checkout.session.completed`, `checkout.session.expired`. Payload is
  `{ id, type, resourceId, data, createdAt }` — `resourceId` is the session or
  payment id, and `data` is free-form ("anything").
- Webhook endpoints are created in the dashboard, not via the agent API.

## Agent Pay / x402 notes (read from the docs, not guessed)

Reference: x402 spec PR #3370. The facilitator is reached at
`{base}/agentpay/x402/{supported,offers,verify,settle}`; MPP charge is at
`{base}/agentpay/mpp/charge`.

- **Direction is the trap.** Ping's facilitator is *payee-side*: it settles to
  the recipient configured on the **API-key org**. Our use is paying agents
  *out*, so we drive the **payer** half of the flow — the #3370 sequence has the
  payer call `/verify` then `/settle` directly. Getting this backwards is the
  single easiest way to build the wrong thing here.
- **Three-step flow:** `offers` (no key) → `verify` with a `quote` payload →
  `settle` with a `deposit` payload. The quote returns the `depositAddress` and
  the `operationToken` in `extra`; we fund the address, then settle with the
  deposit's `txHash`.
- **Scheme is `exact`, `assetTransferMethod: near-intents`, `paymentFlow:
  upfront`.** An unquoted `accepts[]` entry has empty `payTo` and `amount` — the
  amount is only pinned at quote time.
- **`refundTo` is required on the quote payload and has no dashboard fallback.**
  We fail closed locally rather than let Ping fail after a deposit may be in
  flight.
- **One `operationToken` across retries.** `settlement_pending` and
  `INCOMPLETE_DEPOSIT` both mean the deposit exists — retry the *same* token.
  Re-quoting mints a new address and abandons the in-flight deposit.
- **`INCOMPLETE_DEPOSIT` arrives as HTTP 200 with `success: false`.** Reading
  only `success` calls a top-up-able deposit dead. 503/504 are retryable; 402 is
  terminal.
- **A success with no `transaction` hash is not evidence.** Treat as unknown.
- **Agent payments go through the same policy engine as payroll.** A task is
  turned into an Operation first (`operationForTask`), so per-kind caps and
  approval thresholds apply identically.

## Status

Done and tested: `domain`, `policy`, `ledger`, `rails` (incl. 1Click adapter,
PingPay checkout/webhook, Agent Pay x402 + MPP charge), `signer` (OutLayer TEE
custody + FakeSigner), agent orchestration (pay run + agent task payouts), api
skeleton, approvals inbox, policy manifest + drift, PingPay invoices, agent task
payouts + 1099-style export. 182 tests.
Not started: Postgres persistence, web UI.
