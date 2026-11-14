# Crewpay analysis: how money moves

How payouts (single and bulk), approvals, policy, payees, and the surrounding
machinery actually work in this repo, read from the implementation — plus the
live testnet evidence in §12. Code links are relative to the repo root.

## 1. Single payout (one payee, once)

There is no dedicated single-payout endpoint. A single payout is a pay run with
one line: `POST /v1/pay-runs` with `lines: [{ payeeId, usdCents }]` (see
[server.ts](apps/api/src/server.ts) `createPayRun`). Everything below applies
identically to each line of a bulk run; a bulk run is just N of these.

Per line, in order:

1. **Resolve.** The payee is looked up from the store; an unknown payee throws
   (HTTP 500 today — a rough edge, it should be a 400). One
   [`Operation`](packages/domain/src/operation.ts) is built: `amount` is
   `usdCents * 10_000` base units (a 6-decimal-stablecoin assumption),
   `origin` defaults to `base:usdc` (overridable per request),
   `destination`/`recipient` come from the payee record, `corridor` is derived
   (`base:usdc>near:usdc` style), `refundTo` is `crewpay.near`.
2. **Decide.** [`executeRun`](apps/agent/src/payrun.ts) calls
   [`evaluate()`](packages/policy/src/engine.ts) with the operation, the active
   policy, and context (payee record, `spentTodayCents`, payee history, hour).
   Verdicts: `allow`, `allow_with_approval`, `deny`, each with reason codes and
   the policy id/version that produced it.
3. **Settle or hold.** `allow` goes to
   [`settleOperation`](apps/agent/src/payrun.ts): `rail.quote` →
   `signer.plan`/`signer.fund` → `rail.submit` → `rail.poll` (up to 30 polls).
   `allow_with_approval` opens an approval and pays nothing.
   `deny` is recorded and stops.
4. **Record.** Every outcome is persisted via
   [`recordOutcome`](apps/api/src/store.ts): decision + reason codes +
   policy version + status on the operation record, a
   [`SettlementReceipt`](apps/api/src/store.ts) (journal entry ↔ tx hash) when
   settled, and the pay-run line moved to the same status. A notification is
   appended to the outbox (§10).

A settled line also bumps `payeeHistory` and `settledTodayCents`, which feed
later decisions (new-payee approvals, daily cap).

## 2. Bulk payouts (pay runs)

`POST /v1/pay-runs` takes N lines and runs the §1 pipeline per line,
sequentially, inside one [`executeRun`](apps/agent/src/payrun.ts) call. The
sequencing matters: `spentTodayCents` accumulates across settled lines, so the
daily cap binds the whole run, and it is seeded from the store — the cap holds
*across* runs, not per run.

The run gets a summary status: `settled` (everything paid, nothing held/denied/
failed), `partially_settled` (something settled but something else did not), or
`awaiting_approval` (nothing settled). Note the implementation only ever emits
these three; `draft`/`failed` exist in the type but no path sets them.

Read-back:

- `GET /v1/pay-runs?orgId=` — runs newest-first, each with its lines.
- `GET /v1/pay-runs/:id` — one run with per-line states, each line carrying its
  decision record and, once settled, its receipt.
- `GET /v1/operations?orgId=&status=` — every operation with decision + status.

## 3. Approvals (the human gate)

An `allow_with_approval` decision opens an
[`Approval`](packages/domain/src/approval.ts) in `pending` state. Three
properties make it safe:

- **Frozen operation.** The approval stores a snapshot of the `Operation`, not
  a reference. The approver signs an exact amount/recipient/corridor, and later
  edits cannot widen it. `policyId`/`policyVersion`/`reasonCodes` record the
  rules that held it.
- **Two gates, not one.** `POST /v1/approvals/:id/approve` clears the human
  gate only. `POST /v1/approvals/:id/execute` re-runs `evaluate()` against the
  *current* active policy first: if the payee was blocked or the policy
  tightened since, the approval goes `stale` (HTTP 409) and pays nothing.
- **Status is the double-pay guard.** Only `pending` can be decided (approve/
  reject), only `approved` can execute. A second decision is a 409, not a
  no-op. `executed`/`rejected`/`stale` are final.

Execution outcomes mirror settlement: `executed` (journal + receipt recorded,
line settled), `failed` (funding/rail failed, line marked failed), `stale`
(policy now denies), or `needs_review` (funds possibly in flight; the approval
sits in `executing` and the funding request joins the reconcile worklist).
Both `executeRun` and `executeApproved` settle through the single shared
`settleOperation`, so approved money cannot drift from ordinary money.

`GET /v1/approvals?orgId=&status=` is the inbox. Rejections take an optional
note. Every decision and execution appends a notification.

## 4. Policy settings

Policy is configuration, versioned so every decision replays. One policy per
org is active: `POST /v1/policies` deactivates the previous version and bumps
`version`; `GET /v1/policies?orgId=` returns the active one. The rule shape is
[`PolicyRules`](packages/domain/src/policy.ts); defaults come from
`defaultRules()` (500k¢/tx, 5M¢/day, 200k¢ approval threshold, USDC/USDT/DAI,
new payees need approval):

| Rule | Effect |
|---|---|
| `maxPerTransactionCents` | Deny (`PER_TX_CAP`) above this per operation |
| `maxDailyCents` | Deny (`DAILY_CAP`) once the day's settled total + this op exceeds it |
| `approvalThresholdCents` | Hold (`APPROVAL_THRESHOLD`) strictly above this |
| `allowedPayeeKinds` | Deny (`PAYEE_KIND`) other kinds (contractor/vendor/employee/agent) |
| `allowedCorridors` | Deny (`CORRIDOR_NOT_ALLOWED`) others; empty means all |
| `allowedAssets` | Deny (`ASSET_NOT_ALLOWED`) other destination assets |
| `perKindCents` | Extra per-kind cap (`PER_KIND_CAP`), e.g. agents at 50k¢ |
| `requireApprovalForNewPayee` | Hold (`NEW_PAYEE`) payees with no settled history |
| `maxPayeeRiskScore` | Deny (`RISK_SCORE`) at/above it |
| `schedule` | Deny (`SCHEDULE`) outside the hour window (org timezone) |

Payee-state checks add `PAYEE_UNKNOWN`/`PAYEE_BLOCKED` (deny),
`PAYEE_NOT_APPROVED` (hold), `SCREENING_HIT` (deny), `SCREENING_REVIEW` (hold).
Any denial wins over holds; evaluation is pure and deterministic — same inputs,
same decision — which is what makes the audit trail replayable. Money is never
a float anywhere: `bigint` base units and integer USD cents only.

**Two policy layers.** Ours evaluates before funding; the custody wallet's TEE
policy is the backstop. `GET /v1/manifest` compiles our rules into the manifest
to hand the wallet owner (caps → limits, threshold → multisig, corridors/assets
→ allowlists) and warns about rules with no upstream equivalent (new-payee,
risk score, payee kinds). The agent only ever reads the effective TEE policy
back and diffs for drift — it cannot publish policy, by design.

## 5. Payees (the contact list)

A [`Payee`](packages/domain/src/payee.ts) is one row per recipient: `kind`,
display name/email, payout `destination` (chain + asset) and `address`,
`status` (`draft` → `approved`, or `blocked`), `screening`
(`clear`/`review`/`hit`), and optional `riskScore`. `POST /v1/payees`
creates/upserts; `GET /v1/payees?orgId=` lists.

Onboarding shape in practice: create as `draft`/`review` (held by policy until
a human approves the record or the first payment), then flip to
`approved`/`clear` for straight-through runs. Blocking is instant and retroacts
to pending work: `executeApproved` re-checks, so an approval for a newly
blocked payee goes `stale` instead of paying. `payeeHistory` (settled-payment
count) is maintained by the loop, not by hand, and drives the new-payee rule.

Agents are payees too (`kind: "agent"`), paid per task through the identical
policy gate (§8) — there is no softer side channel for machine recipients.

## 6. Settlement rails

Everything rail-specific sits behind
[`SettlementRail`](packages/rails/src/settlement.ts): `quote` → `submit` →
`poll`, with statuses normalized to `quoted/submitted/pending/settled/failed/
refunded`. Money logic never imports a vendor.

- **1Click** ([`oneclick.ts`](packages/rails/src/oneclick.ts)) — production
  cross-chain rail. `EXACT_OUTPUT` quotes so the payee gets exactly the payroll
  amount, `refundTo` set, `appFees` for the take-rate. Asset ids resolve through
  [`AssetRegistry`](packages/rails/src/assets.ts), pinned offline and
  drift-guarded by `npm run verify:tokens`. Mainnet-only, no testnet; dry
  quotes price without a partner key.
- **Testnet** ([`testnet.ts`](packages/rails/src/testnet.ts)) — NEAR testnet
  with mock assets (`near:usdt` → `usdt.fakes.testnet`, 6dp like mainnet).
  1:1 quotes whose deposit address *is* the recipient: the signer pays the user
  directly, no swap. `poll` verifies the broadcast against testnet RPC
  (`EXPERIMENTAL_tx_status`); read failures stay `pending`, never failed.
  Default RPC is FastNEAR — `rpc.testnet.near.org` is deprecated and throttles
  to 429.
- **Fake** ([`fake.ts`](packages/rails/src/fake.ts)) — deterministic offline
  rail for tests and the demo, with injected failures, slow settles, and
  refunds.
- **Agent Pay x402 + MPP** ([`agentpay.ts`](packages/rails/src/agentpay.ts),
  [`mpp.ts`](packages/rails/src/mpp.ts)) — the facilitator path for agent-task
  payouts: offers → quote (pinning deposit address + operation token) → fund →
  settle with the same token on every retry. `INCOMPLETE_DEPOSIT` is a top-up,
  not a failure; a success without a tx hash is treated as unknown.

## 7. Signing and custody

No private key exists in this codebase. Funding goes through the
[`Signer`](packages/signer/src/signer.ts) interface: pure `plan()` (how this
deposit will be funded) then `fund()` (do it). `OutLayerSigner` talks to the
TEE custody wallet holding only a `wk_` API key, over two routes: `intents`
(gasless withdraw, any origin chain) and `onchain` (native transfer or
`ft_transfer` on NEAR). `TestnetSigner` reuses the real funder with mock-token
plans; `FakeSigner` reproduces every outcome offline.

**Funding is four-way, not boolean** (`FundingOutcome`): `deposited` (with
proof) → hand to `submit`; `pending` (in flight / awaiting multisig vote) →
leave unsettled; `failed` with `safeToRetry` (true only when the service proves
nothing executed) → retry only if safe; `needs_review` (unknown fund state) →
escalate, never auto-retry. Retrying unknown state is how money double-pays.

Safety details: idempotency keys derived per operation (a duplicate key arrives
as HTTP 200 with `error: duplicate_idempotency_key`, detected by body);
`X-Answer-Within` bounds synchronous waits; only `processing`/`pending_deposit`
are polled — `pending_approval` settles on human votes, never on polls. The
real tx on the intents route is `result.destination_tx_hash`, not the intent
hashes. `reconcile(requestId)` re-reads the service's own row, read-only, and
backs the worklist in §9.

## 8. Books (double-entry ledger)

Every settlement writes a balanced journal entry through
[`post()`](packages/ledger/src/journal.ts), which throws
`UnbalancedEntryError` per currency if debits ≠ credits. Settlement books
`paymentSettled`: debit payroll-payable (+fee expense), credit stablecoin
clearing. Entries persist in the store and export via `GET /v1/ledger` with a
trial balance (must net to zero per currency — the check that catches a torn
ledger) and a content-hash attestation; the endpoint refuses (500) rather than
report unbalanced books. Each settled operation also gets a receipt linking its
journal entry to the chain tx, so every figure traces to evidence.

## 9. Invoices, agent tasks, reconciliation

- **Invoices (PingPay).** `POST /v1/invoices` opens a hosted checkout session
  (URL stored verbatim, never constructed) with an optional `autoPayRun` payee.
  `POST /v1/webhooks/pingpay` verifies HMAC-SHA256 over `${timestamp}.${rawBody}`
  with a tolerance window, dedupes on event id (Ping retries until 2xx), and
  reads the session back from Ping before acting — the webhook is a claim, the
  session is the truth. A `COMPLETED` session marks the invoice paid and opens
  a pay run through the *same* `createPayRun` path, so policy applies
  identically. `EXPIRED`/`CANCELLED`/`FAILED` close without paying.
- **Agent tasks.** `POST /v1/agent-tasks` turns a task into an ordinary
  `Operation` (`operationForTask`) and runs the same policy gate, then settles
  over x402 (offers → quote → deposit → settle, one operation token across
  retries). Outcomes: `paid` (receipt + journal), `denied`, `awaiting_approval`
  (202, held for a human), `failed`, `needs_review`. `GET
  /v1/exports/agent-payments?orgId=&year=` rolls paid tasks into a 1099-style
  per-payee report with a $600 reporting flag.
- **Reconciliation.** Unresolved fundings (pending, needs_review, unsafe
  failures) keep their custody request id in `store.fundingRequests`, listed at
  `GET /v1/custody/requests` (the worklist) and re-readable at `GET
  /v1/custody/requests/:id`. `POST .../:id/resolve` is read-only by design (a
  `?retry=true` is refused): a confirmed deposit only starts rail polling, and
  the journal entry is written only on rail `settled`. A bare funding `failed`
  stays open; only `refunded`/`rejected` close as failed. Resolved records are
  marked, not deleted, so retries after lost responses are idempotent.

## 10. Notifications and the dashboard

Every terminal or waiting outcome appends to an in-memory notification outbox
(`GET /v1/notifications?orgId=`): `payee_paid`, `payee_denied`,
`approval_needed`, `approval_decided`, `payout_failed`, `payout_needs_review` —
each with its audience (`owner` or a payee id) and a reference. Delivery (email
push) is not wired; the log is what a sender would drain.

The dashboard (`apps/web`, `/app`) is a real client of this API, not a mock:
overview, pay runs, approvals, worklist, payees, invoices, agent tasks, policy,
ledger — all reads live, all buttons real writes. Its honesty rules: fetch
failures show banners, never zeros; unknown statuses render neutral.

## 11. Endpoint map

Health/reads: `GET /health`, `GET /v1/payees`, `GET /v1/policies`,
`GET /v1/pay-runs`, `GET /v1/pay-runs/:id`, `GET /v1/operations`,
`GET /v1/notifications`, `GET /v1/invoices`, `GET /v1/agent-tasks`,
`GET /v1/exports/agent-payments`, `GET /v1/ledger`, `GET /v1/manifest`,
`GET /v1/custody/approvals`, `GET /v1/custody/requests{,/:id}`.
Writes: `POST /v1/payees`, `POST /v1/policies`, `POST /v1/pay-runs`,
`POST /v1/approvals/:id/{approve,reject,execute}`,
`POST /v1/custody/requests/:id/resolve`, `POST /v1/invoices`,
`POST /v1/webhooks/pingpay`, `POST /v1/agent-tasks`. Live/demo:
`GET /v1/live/health`, `/v1/connect{,/handoff}`, `POST
/v1/policies/publish`, `POST /v1/live/dry-run`, `GET /v1/live/custody`.
Conventions: 201 create, 200 ok, 400 bad request, 404 not found, 409 state
conflict (wrong approval status, stale approval, failed execution);
`bigint` crosses the wire as strings.

Known limits (not hidden): in-memory store (no Postgres), no auth on the
console with dev-grade CORS `*`, treasury (Earn/limit-orders/sweeps) not
started, on-chain policy storage needs a funded account, and the 1Click/
`request_completed` webhook is deliberately unbuilt — its signing contract is
unspecified, so reconciliation stays pull-based.

## 12. Live testnet evidence (mock-USDT payout)

*Filled in from the observed run below — §1–§11 describe the code, this
section describes what the chain actually did.*

- **Run 1 — funds moved.** Wallet `e0c64e3c…acbb66` (user-funded 0.2 NEAR
  gas), recipient `e2e-gas-1794631202859.testnet`. Storage deposits and
  `mint({account_id})` succeeded through OutLayer `/call`; the payout
  `ft_transfer` of exactly 1,000,000 base units executed (wallet 10M → 9M,
  recipient 0 → 1M, both read back over RPC). The loop nevertheless reported
  `needs_review`: success rows carry `tx_hash` top-level (OutLayer skill,
  wallet-ops) and the signer read it nested. Fixed in `proof()` and
  `reconcile()` with the nested shape kept as fallback, locked by unit tests.
- **Run 2 — verification, awaiting gas.** Fresh wallet
  `02a09502…a2a922`, same recipient; will prove receipt + ledger booking end to
  end once funded. The helper faucet is rate-limited until ~16:30 UTC, so gas
  is manual until then.
- Observed funding path: helper-funded account → signed 0.3 NEAR gas transfer
  → wallet self-registers on `usdt.fakes.testnet`, mints via the open `mint`,
  registers the recipient — then the real `executeRun` pays through
  `TestnetRail` + `TestnetSigner`, verified by recipient balance delta on RPC.
- Corridor priced live first via a 1Click dry quote (EVM origins need an EVM
  `refundTo` — an implicit NEAR account is refused).
- Environment notes, all observed live: `rpc.testnet.near.org` is deprecated
  and throttles to 429 (FastNEAR is the default now); the mock token has no
  `ft_storage_balance_of` view and `ft_balance_of` returns `"0"` even for
  unregistered accounts, so registration is attempted unconditionally and the
  payout tx itself is the verdict.
- Economics: gas ≈ 0.003 NEAR all-in; mock funds only; nothing mainnet touched.
