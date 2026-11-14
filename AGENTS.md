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
npm run typecheck # tsc --noEmit (core) + web typecheck
npm run web       # TanStack operator console, dev server on :3000
npm run web:build # production build of the console
```

There is no build step for the core packages. They have no runtime
dependencies. The one app with a build step is `apps/web` (Vite + TanStack
Start).

`npm run typecheck` is `tsc --noEmit` over the core packages only: the root
`tsconfig.json` includes `packages/*/src` and `apps/*/src`, and `apps/web` is
plain JavaScript (JSX) under `apps/web/src/`, so tsc never sees it. The console
is checked by `eslint` (`npm run lint` inside `apps/web`) and by the Vite build.

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
- The core toolchain needs no network, but the registry is reachable: `npm
  install` pulls the console's dependencies (React 19 and friends) from the
  network, and `smoke:live` reaches live services. Prefer the standard library
  for the money packages anyway; a dependency in the payment path is a
  liability, not a convenience.
- **`apps/web` is deliberately isolated from the core toolchain.** The root
  `tsconfig.json` includes only `packages/*/src/**/*.ts` and
  `apps/*/src/**/*.ts`, and `apps/web` is plain JavaScript (JSX), so root `tsc`
  and `node --test` never see it. Do not add `.ts` sources under `apps/web/src/`
  or widen the root `include`, or `npm test`/`typecheck` will start type-checking
  the console's dependencies. The web app is built with its own Vite build
  (`npm run web:build`).

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
- **Exact status strings, verified 2026-11-12** against
  `https://app.outlayer.ai/docs/agent-custody`. The withdraw/swap row from
  `GET /wallet/v1/requests/{id}` holds only: `processing` (keep polling),
  `success`, `failed` (a 1Click refund/expiry is *normalized to* `failed`; the
  detail is in `result.reason`), and `needs_review`. A multisig wallet's submit
  may instead return `pending_approval` / `approved` / `rejected`. The docs say
  outright: "Do not invent synonym sets (`settled`/`completed`/…) — none of those
  are emitted." `OutLayerStatus` in `outlayer-client.ts` mirrors this; do not
  widen it. `needs_review` is terminal but special — execution was interrupted
  and the fund state is unknown, so surface it, never auto-retry.
- **A multisig revert surfaces late.** If execution reverts on-chain after the
  threshold is met, it appears as `status: "failed"` via
  `GET /wallet/v1/requests/{id}` — not as a synchronous 422. A synchronous 422
  with `error: onchain_tx_failed` (plus the real `tx_hash`) means the tx *is* on
  chain, so do not retry it.
- **The wallet `request_completed` webhook has no documented signing scheme.**
  Verified by sweeping all 27 `/docs/*` pages: `X-Webhook-Signature` appears only
  on the *tasks* doc and signs the inbox **task** webhook, not wallet funding.
  Do not implement a receiver for it on a guess — see README "Not built".

## PingPay notes (read from the docs, not guessed)

Docs: `https://pingpay.gitbook.io/docs/` — every page has a Markdown twin at
the same URL plus `.md`, and `llms.txt` indexes them all. API base:
`https://pay.pingpay.io/api`. The hosted checkout URL is whatever Ping returns
as `sessionUrl` (live form: `https://pay.pingpay.io/checkout?sessionId={id}`);
treat it as opaque, not as something to build.

- **Checkout and payment routes take the key as `x-api-key`.** Verified live:
  `x-api-key` returns 200, `x-publishable-key` returns 401 — so the docs' header
  name is stale. The same `x-api-key` header carries the org key on the Agent
  Pay facilitator (`/agentpay/x402`, `/agentpay/mpp/charge`), called
  server-side. A publishable key in an agent config is fine; a secret key in a
  browser would not be.
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
- **`customerReference` is a key, not a display name.** The live API rejects a
  space: it must match `/^[a-zA-Z0-9_.:-]+$/` and be at most 128 characters, or
  `POST /checkout/sessions` answers `400 BAD_REQUEST: Input validation failed`
  (verified: "Halcyon Labs" fails, "Halcyon-Labs" passes). A merchant's real
  company name almost always has a space, so derive the reference with
  `toPingReference()` rather than sending `customerId` through. Nothing
  correlates on it — the webhook matches by session id — so the invoice keeps
  the real name and Ping gets a legal key.
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

## Live validation (what is actually reachable, verified 2026-11-12)

`npm run smoke:live` runs the real rails against the real services and asserts
our parsers accept the live payloads. It is **not** part of `npm test`: the unit
suite must stay offline and deterministic. Run it by hand or on a schedule.

- **1Click is mainnet-only and has no testnet**, by design. The token list
  (`GET /v0/tokens`) and a **dry** quote (`POST /v0/quote` with `dry: true`) work
  **with no API key**. A real (non-dry) quote returned `"Failed to get quote"`
  unauthenticated — treat the executable path as needing a partner JWT from
  `partners.near-intents.org`. Unauthenticated is a *fee* tier (25bps vs 20bps),
  not a block, but only for the dry path. `OneClickRail` takes a `dry` flag so
  the smoke test exercises the real client code without a key.
- **Ping x402 discovery is unauthenticated and confirms our assumptions**:
  `GET /agentpay/x402/supported` returns 33 kinds, `x402Version: 2`, `scheme:
  exact`, `extra.assetTransferMethod: near-intents`, `paymentFlow: upfront`.
  `/offers`, `/verify` and `/settle` return **401** without a Ping API key.
  Ping staging exists ("staging+") but publishes no hostname; ask the Ping team.
- **OutLayer testnet is the only real testnet any adapter has**:
  `https://testnet-api.outlayer.ai` (the host *is* the network switch — there is
  no parameter). `POST /register` with an empty body mints a throwaway wallet
  and returns a `wk_` key, so the smoke test needs no external credential.
  All nine paths in `OutLayerClient` were diffed against the published OpenAPI
  spec and exist. NEAR Intents do **not** exist on testnet (no solvers) —
  swaps/intents answer 503 there; wallets and policy work.
- **PingPay's header name is `x-api-key`, not `x-publishable-key`.** Verified
  live: the checkout route returns **401** for `x-publishable-key` and accepts
  `x-api-key` (which carries the `pk_` value). Our client sent the wrong one and
  every fixture test passed anyway, because the mock accepted any header. Fixed;
  this is the single best argument for the smoke test existing.
- **x402 quote works end-to-end live.** `POST /agentpay/x402/verify` with
  `{type:"quote"}` returns `{isValid:true, extra:{depositAddress,
  operationToken, amountIn, refundTo, refundType, refundDeadline}}`, and
  `AgentPayClient.quote()` parses it. `depositAddress` is a 32-byte hex string
  (a NEAR implicit account, not a `0x` address). Unfunded quotes simply expire —
  no money moves at quote time.
- **The quote error field is `invalidReason`/`invalidMessage`, not
  `errorReason`/`code`.** We read the latter, so every live refusal was reported
  as a generic `quote_failed` and the actual cause was invisible. Now reads all
  three (`invalidReason` → `code` → `errorReason`) and appends the message. Docs
  list the error *codes* but never name the field, so only the wire showed this.
- **`refundTo` must be an address on the selected origin chain.** A NEAR origin
  needs a NEAR account; an EVM origin needs an EVM address. Ping fails closed
  (`invalid_exact_near_intents_quote_unavailable`) when they do not match, and
  does **not** fall back to dashboard metadata.
- **The receive asset's decimals matter for the amount.** The configured
  receive asset is `wrap.near` (24 decimals), so `amountOut:"200000"` is dust and
  1Click answers "No liquidity available" — which reads like an outage but is
  really an unquotable size. `amountOut:"1000000000000000000000000"` (1 wNEAR)
  quotes fine. Check decimals before blaming the provider.
- **`GET /agentpay/registration` is the only place the specific blocker
  appears**, so the smoke test reports it verbatim. Observed states, in order:
  `{enabled:false, valid:false, recipientConfigured:false}` → `{enabled:true,
  valid:false, recipientConfigured:true, error:"…Intents balance uses the NEAR
  account saved under Recipient Addresses…"}` → `{enabled:true, valid:true,
  recipientConfigured:true}`. `recipientConfigured` gates the checkout route;
  the balance-backed NEAR account gates the facilitator. Nothing is settable
  over the API (`/api/settings`, `/api/org`, `/api/account`, `/api/me`,
  `/api/config` all 404); it is dashboard state.
- **x402 request shapes match the docs field-for-field.** `verify` body is
  `{x402Version:2, paymentPayload:{payload:{type:"quote",refundTo}}, paymentRequirements:offer}`;
  `settle` adds `operationToken`, `depositAddress`, `txHash` (and `depositMemo`
  when the origin rail needs one). No drift found.
- **`interpretSettle` was verified against the live wire and is correct.** The
  settle response uses `errorReason`/`errorMessage`/`extra.status`, and
  `settlement_pending` and `unknown_payto` both map as intended. Unlike
  verify's error field, the docs were accurate here.
- **`INCOMPLETE_DEPOSIT` is a top-up, not a retry.** Docs: the challenge stays
  active, so **top up the same deposit address and retry settle with the same
  token**. Re-posting a consumed challenge with the same proof is idempotent.
  The retry loop now retries the same token (safe — no new money moves) and, if
  it still has not cleared when the budget runs out, escalates to
  `needs_review` naming the deposit address and operation token. It does **not**
  auto-top-up: the shortfall is not in the response, `FundingPlan` holds no
  post-deposit balance, and inventing an amount would mean sending real funds
  blind. A real top-up needs a wallet balance read that does not exist yet.

- **The ledger was written but never persisted.** Journal entries were produced
  by the pay-run and agent paths and returned to the caller, then dropped — the
  store had no journal map, so `GET /v1/ledger` had nothing to read. Now
  `store.journalEntries` records every entry at the three points money moves
  (pay run, approval execute, agent task), and the export reports them with a
  trial balance and a content-hash attestation.
- **The export fails closed on unbalanced books.** `post()` already rejects a
  single unbalanced entry, but a *set* of fine entries can still be wrong if one
  is missing or duplicated, so the endpoint checks the whole set and returns 500
  rather than report figures it cannot vouch for. The trial balance nets per
  currency, which is the check that catches a torn or truncated ledger.

- **The funding handle was dropped exactly when it was needed.** `interpret()`
  computed the custody request id and carried it on `needs_review` and
  `pending`, but returned it on none of the `failed` branches. A failure that is
  *not* safe to retry means funds may have moved — and that is the one case
  where re-reading the request is the only way to learn the truth. The id is now
  carried on every outcome, kept in `store.fundingRequests`, and readable
  through `/v1/custody/requests`. Only unresolved outcomes are kept: a
  `deposited` or a safe-to-retry failure has no open question.
- **The 1Click webhook is not built, on purpose.** OutLayer names the
  `request_completed` event but never states what signs it or which secret is
  used. Sweeping all 27 `/docs/*` pages: `X-Webhook-Signature` appears on exactly
  one — the *tasks* doc — where it signs the **inbox task** webhook
  (`task_created`/`task_answered`/`task_failed`/`task_expired`), a different
  surface; the wallet funding event is mentioned once with no scheme and no URL
  field (`webhook_url` appears on no page); `X-Binding-Webhook-Secret` runs the
  opposite way (partner → OutLayer). The layer below agrees — the 1Click docs
  document no webhook either, only `GET /v0/status`. A receiver that guesses the
  signed string, or skips verification because the scheme is unclear, accepts a
  forged "settled" event. Reconciliation is pull-based instead, over the
  documented `GET /wallet/v1/requests/{id}`. Add the webhook when the contract
  is confirmed.
- **A funding `success` is not a paid payee.** The OutLayer funding request
  covers moving origin funds to the rail's deposit address; `settleOperation`
  returns before `rail.submit`/`rail.poll` on an unresolved funding, so a
  deposit can land and settle with nobody watching. Booking a settlement on the
  deposit alone would invent money movement. `resolveFunding`
  (`apps/agent/src/reconcile.ts`) therefore treats a confirmed deposit only as
  the point at which it polls the rail (documented `GET /v0/status`) and writes
  the journal entry only on a rail `settled`. Corollary: a bare funding `failed`
  is *not* proof the funds stayed put — only `refunded`/`rejected` are — so it
  stays on the worklist. `POST /v1/custody/requests/:id/resolve` is read-only
  (a `?retry=true` is refused) and marks the record resolved rather than
  deleting it, so a retry after a lost response is idempotent. The deposit quote
  must be kept on the funding record: the deposit address inside it is the only
  key the rail answers a status for. An agent-task funding settles through the
  x402 facilitator, not the 1Click rail, and is recorded as `settlesVia:
  "agentpay"` so resolve does not ask the wrong service.

## Operator console (`apps/web`)

TanStack Start + React 19 + Tailwind + shadcn/ui, built with Vite. The full
build brief is `frontend.md`; the onboarding slice and the ordered plan for the
rest are in `ONBOARDING.md`. Read those before touching the console.

The former Next.js console — landing page included — was deleted. It is
recoverable from git tag `web-nextjs-archive` and is the reference for the
screens the new app does not have yet (agents, testnet).

- **It reads the live API, never fixtures.** There is no seed data anywhere:
  `serve.ts` seeds nothing, and an empty store renders empty screens. Reads go
  through `useRecords(entity)` -> `apiList`; writes through `src/lib/treasury.js`
  -> `apiPost`. Both are same-origin server functions (`src/api/server-calls.js`).
- **Unwired entities fail loudly.** `Payee` is wired through `useRecords`; every
  other entity still throws (`notWired`), and `useRecords` throws for an entity
  missing from `READERS`. A plausible empty table would claim the org has no data
  when the screen is simply not connected — preserve this. Policy and Ledger are
  wired too, but not through `useRecords`: each is a single object/aggregate read
  (`readPolicy`, `readManifest`, `readLedger`), not a list of entities.
- **Mapping is pure and tested.** `src/api/crewpay.js` has no imports, so
  `crewpay.test.js` runs under `node --test`. Copy `toUiPayee`/`toServerPayee`
  exactly for each new entity. USD crosses as integer cents; on-chain amounts
  are strings and are never `Number()`-ed for display.
- **Status vocabulary.** `src/lib/status.js` was written against the Base44
  entity model and its keys do not match the server enums; an unknown value
  renders neutral, so a mismatch is invisible. `ONBOARDING.md` §6 lists every
  mismatch — fix it before building any new screen.
- **Honesty rules.** A fetch failure shows an error, never a zero (a zero reads
  as "nothing wrong"). An unknown status renders unmapped, not healthy. A risk
  or screening value that nothing produced renders as "unscored", not as a
  passing check.

### API endpoints the console relies on

`GET /v1/payees`, `GET /v1/pay-runs` (with `items`, newest first),
`GET /v1/invoices`, `GET /v1/policies` (active policy), `GET /v1/manifest`
(compiled manifest + drift), `GET /v1/ledger` (entries + trial balance), and
`POST /v1/policies` (publish a new version). Plus CORS headers and an `OPTIONS`
preflight in `send`/`handle`.

### Policy and Ledger screens

These two are the differentiators (`ONBOARDING.md` §8 Slice 7), so they carry
more honesty rules than the rest.

- **Publishing always creates a version, never an edit.** `POST /v1/policies`
  bumps `version` and deactivates the previous row, so a past decision still
  replays against the rules that were in force. The form sends rules only — a
  client-supplied `version` would let a caller rewrite history. With no active
  policy the form seeds from `DEFAULT_RULES` (mirroring `defaultRules()`), so v1
  carries real caps rather than `{}`; a `404 no active policy` is an empty state,
  not an error, and must not hide the form.
- **The manifest shows what did NOT travel.** `compileManifest` reports every
  rule OutLayer cannot enforce (`warnings`) rather than dropping it silently, so
  the manifest never looks stronger than it is. Render the warnings; do not
  filter them.
- **Drift is reported, never corrected.** The wallet's policy is the owner's.
  When a custody signer is present the API diffs it against ours; an absent
  wallet field is itself drift (an absent limit is not the limit we proposed).
  With no signer there is nothing to compare, so the panel says "drift not
  checked" rather than implying agreement.
- **Ledger amounts are exact base units, never dollars.** An entry's postings
  carry a base-unit string at the asset's own scale, and the scale is not in the
  entry, so the screen shows the string verbatim and never `Number()`-es it into
  a dollar figure. `toUiLedger` keeps them strings (`String(...)`) for the same
  reason. The API refuses to report an unbalanced ledger, so a ledger error is a
  real integrity failure, not a fetch problem — the screen names the currency.

### Live testnet and the connect/policy screens

CrewPay runs on NEAR testnet only: the money path is `TestnetRail` +
`TestnetSigner` against a server-held OutLayer testnet wallet, registered at boot
in `serve.ts`. There is no demo or simulated mode and no seed data. The read-only
probes in `apps/api/src/live.ts` (`LiveServices`) hit the real endpoints, so
`/v1/live/health` is a genuine reachability check.

- **`/v1/connect` mints a real wallet but must never return its key.** OutLayer's
  `/register` returns `handoff_url` with the `wk_` API key in its query string.
  This API is served publicly, so serialising that URL puts the key in the page
  DOM for anyone to read. Instead `GET /v1/connect` returns `hasHandoff: boolean`
  and the dashboard links to `/v1/connect/handoff`, which 302-redirects
  server-side. `live.test.ts` asserts no response body contains `wk_`. Do not
  reintroduce the URL into any JSON response.
- **Compiled is not stored.** `encrypt-policy` + sign work on an unfunded wallet,
  but storing the policy on-chain does not. So the TEE reports `policy: "none"`
  and a dry-run that passes means *nothing refused it*, not yet that the limits
  allowed it. The UI says this in as many words; keep it that way.
- **A funded wallet is the only thing between testnet and a real payout.** The
  wallet is minted unfunded at boot and the key lives in memory only, so a
  restart mints a fresh one and gas must be re-sent. The console says so rather
  than implying funds are moving when they are not.
- **The pay-run funding origin must be one this deployment can settle.** The
  server defaults `origin` to `base:usdc`, but the testnet adapters only map the
  corridors in `MOCK_ASSETS` (`near:usdt`, `near:usdc`). An omitted origin
  therefore fails every line at execution with `no testnet mock known for
  base:usdc` — after approval, not before, so the run looks fine until money
  should move. The console sends `origin` explicitly (NewRunForm, default
  `near:usdt`); any new caller of `POST /v1/pay-runs` must do the same.
- **A run's status is a rollup, not a one-time snapshot.** `createPayRun`
  computes `status` from the decision phase, but lines move later when approvals
  execute. `refreshRunStatus` (called from `recordOutcome`) re-derives it, so a
  run whose only line failed reads `failed` instead of `awaiting_approval`
  forever. The line also carries the server's `note` (the chain's own refusal),
  surfaced in `RunLines` — a failed payout the operator cannot see the reason for
  is indistinguishable from a silent one.


## Authentication and org ownership

The API requires a bearer token. This replaced a scheme where `orgId` came from
the request: an omitted `orgId` returned **every** org's rows, and naming an org
returned that org's payroll to anyone — anonymous read of payroll and the books,
and anonymous write of policy. That is closed.

- **The org is the caller's, never the request's.** `apps/api/src/auth.ts`
  resolves a `Principal` (token → `orgId`) and `handle` gates *before* routing,
  so a handler added later is protected by default rather than by remembering.
  Handlers call `access.org(requested)`: it returns the caller's org when none is
  named, and `undefined` when a *different* org is named. `undefined` must become
  **404, not 403** — a 403 confirms the id exists.
- **Public by design, and only these**: `/health`, `/v1/live/health` (the console
  shows real infrastructure), and `POST /v1/webhooks/pingpay`, which carries
  an HMAC over the raw body because Ping cannot present a token. The webhook is
  its own function (`handlePingWebhook`) precisely so the gate cannot swallow it.
- **Two by-id checks matter as much as the list filters**: `GET /v1/pay-runs/:id`
  and `/v1/approvals/:id/(approve|reject|execute)` compare `orgId`, and
  `createPayRun` refuses a payee from another org — otherwise a caller could pay
  a stranger's contractor.
- **The token never reaches the browser.** The console calls same-origin server
  functions (`apps/web/src/api/server-calls.js`) that attach it server-side. No
  `VITE_`/`NEXT_PUBLIC_` token: a value the browser can read is a value an
  attacker can read. `serve.ts` refuses to start without `CREWPAY_API_TOKEN`;
  `scripts/redeploy.sh` generates one for both processes.
- **Secrets live in a gitignored `.env`, never in the repo.** `PING_API_KEY` and
  `PING_WEBHOOK_SECRET` belong there; `.env.example` documents the keys.
  `npm run api` and `npm run smoke:live` load it with
  `node --env-file-if-exists=.env` (an already-set shell var wins), and
  `redeploy.sh` sources it with `set -a`. A key committed once stays in history
  even after a later delete, so the file is ignored from the start.
- **Never build under a running server.** `vite build` rewrites
  `dist/client/assets/*` with new content hashes and deletes the old files, so a
  server started before the build serves HTML naming assets that no longer exist:
  every route still returns 200, but the stylesheet 404s and the page renders
  unstyled. Always rebuild first, then restart (`scripts/redeploy.sh` does both in
  that order).
- **This is a client credential, not a user login.** It scopes an org, not a
  person. Multi-user identity, and pinning CORS off `*`, remain open.

## Cross-chain payments

`CrossChainRail` (`packages/rails/src/crosschain.ts`) is the router a pay run
settles through. It is a `SettlementRail`, so `settleOperation` drives it
unchanged; the only new behaviour is an honest verdict on reachability:

- A **NEAR corridor** (`operation.destination.chain === treasury.chain`) goes to
  the NEAR rail (`TestnetRail` on testnet), which really broadcasts.
- A **corridor to another chain** is priced for real — a keyless 1Click
  `dry: true` quote, wired from `LiveServices.crossChainPrice()` — then reported
  as `crosschain_unreachable`. The destination swap runs on mainnet, which a
  testnet deployment cannot reach, so no destination tx hash is ever claimed.
  The live price rides along in `evidence.crosschainPrice` so an operator sees
  what the corridor would have cost.

`CrossChainRail` exposes an optional `preflight(op)` on `SettlementRail`.
`settleOperation` calls it **before quoting or funding**: an unreachable
corridor is refused before the signer moves anything, so no deposit is ever
orphaned on-chain for a swap that cannot complete. Only `CrossChainRail`
implements it; every other rail omits it and is unaffected.

Keyless 1Click quotes a real price (`amountIn`, `amountOut`, fees, `timeEstimate`)
but **never** a deposit address — minting one needs a partner key
(`ONECLICK_API_KEY`). The router never needs a deposit address, because it never
executes the outbound swap.

## NEP-366 gas relay

`Relayer` (`packages/rails/src/relayer.ts`) is the gas-sponsorship service. A
payee (or an agent) that holds no NEAR signs a delegate action and posts it to
`POST /v1/relay` as base64 borsh. The relayer decodes the exact bytes
(`decodeSignedDelegateAction`), verifies the sender's signature and checks it
against its policy (`validateDelegateAction`), spends the nonce
(`NonceGuard`), then assembles the outer transaction (`planRelay`).

The broadcast is the one step not performed: OutLayer's wallet API can only emit
`transfer`/`ft_transfer`/`call`, never `Action::Delegate`. So a valid action
returns `status: "planned"`, `broadcastable: false`, and a note saying exactly
that — it never claims a tx hash it did not produce. The receiver allow-list is
the payee account, so the relayer can only forward an action back to that
account; it is never a chain-wide gas faucet.

## Status

Done and tested: `domain`, `policy`, `ledger`, `rails` (incl. 1Click adapter,
PingPay checkout/webhook, Agent Pay x402 + MPP charge, TestnetRail,
`CrossChainRail`, NEP-366 `Relayer`), `signer` (OutLayer TEE custody +
TestnetSigner), agent
orchestration (pay run + agent task payouts), api skeleton, approvals inbox,
policy manifest + drift, PingPay invoices, agent task payouts + 1099-style
export, funding reconciliation into the books, the TanStack operator console
(Payees, Policy and Ledger wired; pay runs, approvals, invoices and worklist
still pending), the live connect/policy path
(`LiveServices`, `live.test.ts`), and bearer-token auth with org ownership.
358 tests.
Not started: Postgres persistence, multi-user identity (the token identifies an
org, not a person; CORS is still `*`), and on-chain policy storage (needs a
funded account).
