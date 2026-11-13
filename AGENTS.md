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
npm run web       # Next.js landing page, dev server on :3000
npm run web:build # production build of the landing page
```

There is no build step for the core packages. They have no runtime
dependencies. The one app with a build step is `apps/web` (Next.js).

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
  install` pulled Next 16 and React 19 from the network, and `smoke:live`
  reaches live services. Prefer the standard library for the money packages
  anyway; a dependency in the payment path is a liability, not a convenience.
- **`apps/web` is deliberately isolated from the core toolchain.** The root
  `tsconfig.json` includes only `packages/*/src/**` and `apps/*/src/**`, and
  `apps/web` keeps its sources in `app/` + `components/` (no `src/`), so root
  `tsc` and `node --test` never see it. Do not move web sources under `src/` or
  widen the root `include`, or `npm test`/`typecheck` will start type-checking
  JSX. The web app is built with its own `next build`.

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

## Landing page (`apps/web`)

Next.js 16 + React 19, App Router, no other deps. One static route.

- **Design system is the "Acctual" style reference**: a *light* theme on a
  paper-white canvas. Near-monochrome ink with a single electric-blue accent
  used only as functional punctuation (checkmarks, eyebrow labels) — never as a
  button or surface fill. Flat solid fills, **no gradients anywhere**, and no
  box-shadow on content cards (elevation is reserved for the nav pill, the paper
  mockups, and the testimonial card).
  - Palette: paper `#ffffff`, snow `#fafafa` / `#f7fafc` for alternating bands,
    ink `#1e1e1e`, smoke `#666666` (the readable floor — never lighter for
    body), fog `#8d8d8d`, mist `#ccd1da` borders, midnight `#0d111b` filled
    buttons, electric blue `#0098f2`, iris `#6c56fc`, leaf `#5d9c06`.
  - Shape: pill (100px) for all controls, 16px content cards, 20px images,
    32px large panels. No radius below 10px on anything interactive.
  - Type: **Inter** as the Open Runde substitute (weight 600 display, 500 body,
    -0.03em tracking at 20px+), **Caveat** for handwritten annotations only.
  - Tokens live in `app/globals.css` under `:root`; the reference's full token
    block is mirrored there.
- **Sections**: pill nav → hero with a layered paper-invoice stack → stats →
  large feature panel → capabilities (`01`–`04`) → flows → why-us → proof →
  pricing → FAQ (`<details>`) → CTA → footer.
- **The hero paper stack is the signature element** (`components/PaperStack.tsx`):
  three invoice/pay-run sheets, offset and rotated, rendered as real UI. Its data
  mirrors what `npm run demo` actually produces (contractor settles, vendor held
  for approval, agent paid per task, one line stops for review). Keep it truthful
  if the demo changes.

### Landing page copy rules (do not weaken these)

The page sells a real product, so the copy is constrained by what is true:

- **Never claim**: EOR / licensed payroll / money transmission, "compliant in
  N countries", SOC2/ISO certification, holding customer funds, or paying out in
  local currency. The FAQ states the negatives on purpose — keep those.
- **Never invent** testimonials, customer logos, or "trusted by N teams". The
  reference style has a starred testimonial block; we have no customers yet, so
  it is not used. Social proof is replaced with **verifiable proof** — endpoints
  and invariants (`Σ = 0`, drift check, non-custodial) a reader can check.
- Pricing figures on the page are illustrative for design review, and the page
  says so. Do not present them as a published rate card.
- The strongest true claims are the differentiators: no LLM in the money path,
  unknown funding stops instead of retrying, and a confirmed deposit is not a
  paid payee.
- Keep the palette discipline: at most two chromatic accents on any one screen.

## Status

Done and tested: `domain`, `policy`, `ledger`, `rails` (incl. 1Click adapter,
PingPay checkout/webhook, Agent Pay x402 + MPP charge), `signer` (OutLayer TEE
custody + FakeSigner), agent orchestration (pay run + agent task payouts), api
skeleton, approvals inbox, policy manifest + drift, PingPay invoices, agent task
payouts + 1099-style export, funding reconciliation into the books, and the
`apps/web` Next.js landing page. 215 tests.
Not started: Postgres persistence, authenticated app console (the landing page
is the only frontend so far).
