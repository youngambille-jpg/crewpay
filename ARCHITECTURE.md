# Crewpay — Architecture

Payroll and payouts for the agentic workforce. A policy-guarded agent runs a
company's global pay runs on stablecoin rails; payees are contractors, vendors,
and AI agents that get paid per completed task.

This document is the design of record. It describes the components, the data
model, the money flows, and how each external rail is used. The guiding rule is
that **the rails are a commodity and the trust-and-books layer is the product**,
so the policy engine and the ledger are the parts we own end to end.

## 1. Design principles

1. **Non-custodial by default.** Crewpay never holds customer funds. Fiat and
   stablecoins sit with the customer's account provider (e.g. Endl, OneSafe) or
   in their own NEAR Intents balance. Crewpay only *authorizes* movement.
2. **The agent proposes, policy disposes.** Every money movement is an
   `Operation` produced by the agent and evaluated by the policy engine before it
   can be signed. The engine is deterministic, auditable, and has no LLM in it.
3. **Humans set constraints once.** Per-transaction caps, daily caps, payee
   allowlists and approval thresholds are configuration. Only exceptions (above
   threshold) reach a human, as a one-signature approval.
4. **Everything is reconciled.** Every operation produces a signed receipt and a
   double-entry journal line, so the books are correct by construction and
   auditable from chain.
5. **One rail per job.** NEAR Intents 1Click for cross-chain settlement, PingPay
   for fiat collection and agent paywalls, OutLayer for custody and attestation.
   We do not re-implement any of them.

## 2. System context

```
                 ┌──────────────────────────────────────────────┐
                 │                 Crewpay                      │
                 │                                              │
 Payroll CSV ───▶│  api  ──▶  agent (planner) ──▶  policy       │
 Accounting  ───▶│                 │                  │         │
 Webhooks    ───▶│                 ▼                  ▼         │
                 │              ledger  ◀──  signer (OutLayer)   │
                 │                 │                  │         │
                 └─────────────────┼──────────────────┼─────────┘
                                   │                  │
              ┌────────────────────┼──────────────────┼───────────────┐
              ▼                    ▼                  ▼               ▼
        PingPay (fiat)    NEAR Intents 1Click   OutLayer TEE    Payee wallets
        checkout/onramp   cross-chain settle    custody+policy   (any chain)
        agent paywalls    signed intents        attestations
```

## 3. Components

### 3.1 `api` — control plane (TypeScript / Fastify)

The only thing a customer's systems talk to. Stateless, horizontally scalable.

Responsibilities:
- Auth and multi-tenancy (orgs, members, API keys, scopes).
- CRUD for payees, pay runs, invoices, policies, webhooks.
- Ingest: CSV/API payroll, accounting sync (QuickBooks/Xero), inbound
  PingPay/1Click webhooks.
- Enqueue work onto the job queue; never moves money itself.
- Serves the approvals inbox and the ledger read model.

Key endpoints (initial surface):

```
POST   /v1/payees                      create/upsert a payee (chain + token + address)
POST   /v1/pay-runs                    create a pay run from a source (csv|api|invoice)
POST   /v1/pay-runs/:id/submit         hand the run to the agent
GET    /v1/pay-runs/:id                run status, per-item state, receipts
GET    /v1/operations                  list operations + policy decisions
GET    /v1/approvals                   approvals inbox (?orgId=&status=)
POST   /v1/approvals/:id/approve       one-signature owner approval
POST   /v1/approvals/:id/reject        decline, with a reason
POST   /v1/approvals/:id/execute       pay an approved operation (re-checks policy)
GET    /v1/manifest                    compile the policy to an OutLayer manifest + drift
GET    /v1/custody/approvals           mirror the wallet's own multisig inbox
POST   /v1/invoices                    issue an invoice (PingPay checkout)
POST   /v1/webhooks/pingpay            payment settled -> trigger pay run / reconcile
POST   /v1/webhooks/1click             swap status transitions
GET    /v1/ledger                      journal export (CSV/JSON) + attestations
```

### 3.2 `agent` — the planner and executor (TypeScript worker)

Turns intent into operations, then drives each operation to settlement. It is
the only component that calls rails, and it can only act through the policy
engine and the signer.

- **Planner.** Given a pay run, resolves each line to a payee, chooses a corridor
  (payee's preferred chain + token), and emits one `Operation` per line.
- **Optimizer.** Batches same-corridor lines, applies limit orders for FX,
  parks idle cash in 1Click Earn, sweeps surplus. Constrained by policy.
- **Executor.** For each approved operation: quote → sign → deposit/submit →
  poll to terminal state → record receipt. Handles refunds on failure.
- **Watchtower.** Reconciles inbound payments (PingPay webhooks), retries
  retryable states, escalates stuck operations to the approvals inbox.

The planner may use an LLM to interpret unstructured inputs (an email, a Slack
message, a scanned invoice). The LLM only ever emits a *proposed* operation
list. It has no signing authority and no rail credentials.

### 3.3 `policy` — the constraint engine (TypeScript, pure)

The moat. A pure function:

```
decide(operation, context) -> { decision, reasons[], requiresApproval }
```

`decision ∈ {allow, allow_with_approval, deny}`.

Rule dimensions (all configurable per org, per payee, per corridor):

| Dimension | Example rule |
| --- | --- |
| Per-transaction cap | `amount <= 5,000 USD` |
| Daily / weekly cap | `sum(day) <= 50,000 USD` |
| Payee allowlist | payee must be `approved` and not `blocked` |
| Corridor allowlist | only `USDC/Base -> USDC/NEAR` and `USDC/Base -> USDC/Arbitrum` |
| Asset allowlist | payouts only in `USDC`, `USDT`, `DAI` |
| Approval threshold | `amount > 2,000 USD` ⇒ human approval |
| Velocity / anomaly | new payee, or >3σ vs. trailing 90d, ⇒ approval |
| Sanctions / screening | deny on screening hit (SHIELD, provider list) |
| Schedule | only `Mon–Fri 09:00–18:00` in org timezone |
| Recipient type | `agent` payees capped at `500 USD/task` |

The engine is deterministic and side-effect free so it is unit-testable and its
output can be replayed. Every decision is persisted with the rule set version
that produced it, for audit.

### 3.4 `ledger` — double-entry books (TypeScript)

Every state change writes balanced journal entries:

```
PayRunCreated      Dr  Payroll Expense        Cr  Payroll Payable
PaymentSettled     Dr  Payroll Payable        Cr  Stablecoin Clearing (asset)
TreasuryConverted  Dr  Stablecoin Clearing    Cr  Stablecoin Clearing (other corridor)
FeeCollected       Dr  Stablecoin Clearing    Cr  Revenue
Refunded           Dr  Stablecoin Clearing    Cr  Payroll Payable
```

Tables: `accounts`, `journal_entries`, `postings`, `receipts`. A `receipt`
links a journal entry to its on-chain evidence (tx hash, signed quote,
attestation). This is what makes the books auditable and is the basis for the
accounting exports.

### 3.5 `signer` — custody boundary (OutLayer)

There is no private key in Crewpay. The org's treasury lives in an OutLayer
TEE-held wallet, and Crewpay holds only a `wk_` API key. Crewpay:

1. submits the operation to the policy engine;
2. on `allow`, funds the rail's deposit address from the custody wallet;
3. on `allow_with_approval`, opens an OutLayer task (owner inbox) and waits;
4. records the deposit proof against the ledger entry.

OutLayer gives us TEE-held multi-chain wallets, a policy engine, multisig
approvals, gasless payment checks, confidential NEAR Intents, and on-chain
attestation. Crewpay's own policy engine runs *before* OutLayer's, so OutLayer
is the second line of defence and the custody boundary.

**Implemented (`packages/signer`).** `Signer` has two methods: `plan`, a pure
decision about how a deposit will be funded, and `fund`, which executes it and
returns a `FundingOutcome`. `OutLayerSigner` is the real one; `FakeSigner` is
the offline one, and it reproduces every outcome variant so the orchestrator's
handling of the hard cases is tested without a network.

Two funding routes exist and they are not interchangeable:

- **`intents`** — `POST /wallet/v1/intents/withdraw`, a gasless NEAR Intents
  withdraw that delivers the origin asset to the rail's deposit address. Needs
  no gas token and works from any origin chain.
- **`onchain`** — `POST /wallet/v1/transfer` for native NEAR, or `POST
  /wallet/v1/call` with `ft_transfer` for a NEP-141 token. Needs NEAR for gas,
  and the recipient must have token storage registered.

`plan` picks `intents` for any non-NEAR origin and `onchain` for a NEAR origin.

**Funding is not a boolean.** `FundingOutcome` is a four-way union because the
wrong choice retries a payment that may already have moved:

| Outcome | Meaning | Caller action |
|---|---|---|
| `deposited` | Broadcast; carries the proof | Hand the proof to `submit` |
| `pending` | In flight or awaiting multisig | Leave unsettled; resolve later |
| `failed` | Did not complete; `safeToRetry` says whether funds could have moved | Retry only when `safeToRetry` |
| `needs_review` | Fund state **unknown** | Escalate to a human; never auto-retry |

The classification follows the service's own semantics: `failed` is retryable
only when `result.never_executed` or `result.never_submitted` is set, since a
bridge failure or refund may otherwise have moved funds; `needs_review`,
`rejected`, and `refunded` are mapped explicitly. The terminal-status set is
kept exact — no invented synonyms — so nothing silently falls through.

**Proof is the delivery tx, not the intent hash.** On the `intents` route the
only real transaction is `result.destination_tx_hash`; `transfer_intent_hash`
and `intent_hash` are solver-relay identifiers, not chain transactions. On the
`onchain` route it is `result.tx_hash`. A `success` that returns no identifier
is escalated to `needs_review` rather than reported as funded.

**Idempotency.** Every state-changing call carries an `X-Idempotency-Key`
derived from the operation id, so a retry after a timeout sends the same key
and the server answers with the original request. The duplicate arrives as HTTP
200 with `error: duplicate_idempotency_key`, not a 4xx, so it is detected
explicitly. `X-Answer-Within` bounds the synchronous wait, so a slow settlement
answers with a request id to poll instead of holding the connection open.

**Polling.** `processing` and `pending_deposit` are polled to a terminal
status. `pending_approval` is deliberately *not* polled: a multisig wallet
settles it only when a human votes, so polling would spin until a false
escalation.

### 3.5a Approval workflow

An `allow_with_approval` decision does not pay and does not disappear: it opens
an `Approval` in the inbox and the operation stays unpaid until a human decides
it. Three properties make this safe rather than a second, weaker path to money.

**The operation is frozen.** The approval stores a snapshot of the `Operation`
as it was evaluated, not a reference to live state. An approver signs off on an
exact amount, recipient and corridor, and a later edit to a pay run cannot widen
what they agreed to. `policyId`/`policyVersion` are recorded alongside so the
audit trail shows the rules in force at decision time.

**Approval clears the human gate, not the policy gate.** `executeApproved`
re-runs the policy engine against the *current* active policy before paying.
Two things may have changed since the request: the payee (now blocked, or
re-screened as a hit) or the policy (a lowered cap, a corridor removed). Either
turns the approval `stale` — a 409 with the reason codes — rather than paying,
because the approver agreed to different terms than the ones now in force.

**One decision, one payment.** `pending` is the only status that can be
decided; a second approve/reject is a 409 conflict, not a silent flip, so a
retried request cannot reverse a decision. `executed`, `rejected` and `stale`
are final, and execution requires `approved`, so a replayed `execute` cannot
pay twice. The money path itself is shared with the pay run — both call
`settleOperation`, so an approved payment cannot drift from an ordinary one.

The `ApprovalStatus` lifecycle:

```
pending ──approve──▶ approved ──execute──▶ executed
   │                    │            └────▶ failed      (funding/rail failed)
   │                    └─────────────────▶ needs_review (unknown fund state)
   ├──reject──▶ rejected
   └──(policy changed at execute time)────▶ stale
```

### 3.5b Two policy layers, and which one wins

The policy is enforced twice, by two engines that do not share code, on purpose.
Ours (`packages/policy`) is deterministic and evaluates the operation before
anything is funded. OutLayer's lives in the TEE and evaluates the transaction
the custody wallet is about to sign. The second one is the backstop: it holds
even if our engine has a bug, or is bypassed, or the agent is compromised.

`compileManifest` turns our `PolicyRules` into the manifest OutLayer understands
and reports the rules that did **not** travel:

| Crewpay rule | OutLayer manifest | Note |
|---|---|---|
| `maxPerTransactionCents`, `maxDailyCents` | `limits.per_transaction`, `limits.daily` | decimal strings, never floats |
| `approvalThresholdCents` | `multisig.approval_above` | the wallet's own ballot gates it too |
| `allowedCorridors` | `chains.allowed` | |
| `allowedAssets` | `tokens.allowed` | |
| `schedule` | `time_restrictions` | needs the org timezone |
| `requireApprovalForNewPayee` | — | no payee-history concept upstream; warned |
| `maxPayeeRiskScore` | — | no scoring upstream; warned |
| `allowedPayeeKinds` | — | no kind model upstream; warned |

The warnings are the honest part. A rule with no equivalent keeps its protection
in our engine and only ours, and the API says so rather than implying the
manifest covers it. Two consequences that shape the design:

**The manifest is a proposal, not a write.** OutLayer policy is authored by the
wallet's owner in the dashboard; there is no agent endpoint that sets it, and
that is deliberate — the party being limited must not be the party that sets the
limit. So `GET /v1/manifest` compiles the rules and hands them over, and the
agent can only ever *read back* the effective policy. It reads, diffs, and
reports drift; it never rewrites the owner's policy to match its own idea of it.

**Every signing door is shut by default.** OutLayer capability toggles default
to DENY, so the manifest states them explicitly: funding a deposit needs
`intents_withdraw`, `intents_transfer` and `call`, and nothing else. `raw_sign`,
`evm_sign` and `solana_sign` stay off, and `intents_call` is always false (a
call to `intents.near` can add a key that signs outside the TEE for good). A
compromise of the agent therefore cannot extract arbitrary signatures — only
move money within the limits the owner already agreed to.

The two inboxes are distinct and both are surfaced. `GET /v1/approvals` is our
own approval record, where a human clears an operation our engine held back.
`GET /v1/custody/approvals` mirrors the wallet's multisig inbox, where a human
votes on a request the TEE held back — a request that returned
`pending_approval` settles only on a vote, so it is read, never polled.

### 3.6 `store` — Postgres

Single source of truth for orgs, payees, pay runs, operations, decisions,
journal, receipts, and webhook events. Redis for the job queue and idempotency
locks.

## 4. Data model (core tables)

```
org(id, name, timezone, created_at)
member(id, org_id, email, role)              -- owner | admin | approver | viewer
api_key(id, org_id, hashed, scopes[], last_used_at)

payee(id, org_id, kind, display_name, email,
      chain, token, address,                       -- payout destination
      preferred_corridor,                          -- e.g. base:usdc -> near:usdc
      status,                                      -- draft|approved|blocked
      screening_state, risk_score, created_at)
payee_kind ∈ {contractor, vendor, employee, agent}

pay_run(id, org_id, source, source_ref, period, currency, total_amount,
        status, created_by, created_at)
pay_run_item(id, pay_run_id, payee_id, amount, currency, corridor,
             operation_id, state)

operation(id, org_id, pay_run_item_id, type, amount, currency,
          origin_chain, origin_asset, dest_chain, dest_asset, recipient,
          refund_to, deadline,
          decision, decision_reasons[], policy_version,
          approval_id, status,                     -- proposed|approved|signing|submitted|settled|failed|refunded
          quote_id, deposit_address, tx_hash, receipt_id, created_at)

policy(id, org_id, version, rules_json, active, created_at)
approval(id, org_id, operation_id, requested_at, requested_of,
         approved_by, approved_at, signature, state)

journal_entry(id, org_id, kind, memo, created_at)
posting(id, journal_entry_id, account, direction, amount, currency)
receipt(id, org_id, operation_id, evidence_kind, evidence_ref, attestation, created_at)

invoice(id, org_id, customer, amount, currency, checkout_id, status)
webhook_event(id, provider, external_id, payload, received_at, processed_at)
```

## 5. Money flows

### 5.1 Outbound pay run (the core loop)

```
1. api        create pay_run from CSV/API/accounting sync
2. agent      resolve payees, choose corridors, emit one Operation per line
3. policy     decide() each Operation  -> allow | allow_with_approval | deny
4. api        surface exceptions in the approvals inbox
5. owner      approve with one signature (OutLayer task)
6. signer     OutLayer signs/executes under the org policy manifest
7. agent      1Click: POST /v0/quote (EXACT_OUTPUT, appFees, refundTo)
                 - funds already in Intents -> depositType INTENTS, generate-intent,
                   user/agent signs off-chain, POST /v0/submit-intent
                 - funds on origin chain   -> depositType ORIGIN_CHAIN, send deposit
               poll /v0/status to terminal settlement
8. agent      write receipt + journal entry; update pay_run_item state
9. api        notify payee and owner; expose run summary and ledger export
```

`EXACT_OUTPUT` is used so the payee receives exactly the payroll amount and
Crewpay absorbs the fee from the input side. `appFees` collects Crewpay's
take-rate to a NEAR recipient.

### 5.2 Inbound collection (invoice → cash → pay run)

```
1. api     create invoice -> PingPay hosted checkout / payment link
2. payer   pays by card, fiat, or any chain (PingPay abstracts it)
3. pingpay webhook -> payment settled to org's preferred stablecoin
4. ledger  Dr Clearing Cr Revenue/Receivable
5. policy  optionally auto-trigger the scheduled pay run on collection
```

### 5.3 Paying an agent for work (agent-to-agent)

```
1. agent   task completion event (own agent, or a counterparty agent)
2. policy  agent payee rules: per-task cap, allowlist, approval threshold
3. agent   settle per task:
             - small, high-frequency  -> x402/MPP via PingPay Agent Pay facilitator
             - larger or batched      -> 1Click payout like any other payee
4. ledger  receipt per task; agent payees get a payee record and 1099-style export
```

### 5.4 Treasury (autonomous)

The agent keeps the treasury within policy: convert surplus to the operating
stablecoin, park idle balances in 1Click Earn, use limit orders for FX at target
rates, and sweep to the org wallet. All of it is expressed as operations and
subject to the same policy engine.

## 6. Rails mapping

The rail layer is `packages/rails`. Everything rail-specific sits behind the
`SettlementRail` interface (`quote` → `submit` → `poll`), so money logic never
imports a vendor. `OneClickRail` is written against the published OpenAPI spec
at `https://1click.chaindefuser.com/docs/v0/openapi.yaml`.

| Need | Rail | Concrete calls |
| --- | --- | --- |
| Cross-chain payout | NEAR Intents 1Click | `POST /v0/quote`, `POST /v0/deposit/submit`, `GET /v0/status`, `appFees`, `refundTo` |
| Asset identity | 1Click | `GET /v0/tokens` → `AssetRegistry` (id + decimals per asset) |
| Fund without on-chain wait | 1Click Intents | `depositType: INTENTS`, signed intent execution |
| Privacy for sensitive pay | 1Click confidential | `confidentiality` / `CONFIDENTIAL_INTENTS` |
| Fiat collection / invoicing | PingPay | hosted checkout, headless payments, subscriptions, onramp, webhooks |
| Agent paywalls / per-task pay | PingPay Agent Pay | x402 (`/agentpay/x402`), MPP (`/agentpay/mpp/charge`) |
| Custody, policy, approvals, attestation | OutLayer | TEE wallets, policy manifest, tasks/inbox, payment checks, transparency proofs |
| Yield on idle treasury | 1Click Earn | Earn endpoints |
| Screening | SHIELD / provider | incident + screening checks before `allow` |

### What the 1Click adapter actually does

- **`quote`** posts the full required field set (`dry`, `swapType`,
  `slippageTolerance`, `originAsset`, `depositType`, `destinationAsset`,
  `amount`, `refundTo`, `refundType`, `recipient`, `recipientType`, `deadline`)
  with `swapType: EXACT_OUTPUT` so the payee receives exactly the payroll
  amount. `amount` is the destination amount in base units.
- **Asset ids come from the service, not from guesswork.** `AssetRegistry`
  resolves `chain:asset` to a 1Click id and carries decimals. A wrong id sends
  funds to the wrong asset, so the offline table is pinned and guarded by
  `npm run verify:tokens`, which checks it against the live `GET /v0/tokens`.
- **`submit`** calls `POST /v0/deposit/submit` with the deposit tx hash once the
  signer has broadcast. Without a proof it reports `submitted` and leaves the
  deposit address live.
- **`poll`** calls `GET /v0/status` with `depositAddress` (and `depositMemo`
  when the quote returned one) and maps 1Click's status vocabulary onto the
  internal one: `KNOWN_DEPOSIT_TX | PENDING_DEPOSIT | INCOMPLETE_DEPOSIT |
  PROCESSING → pending`, `SUCCESS → settled`, `REFUNDED → refunded`,
  `FAILED → failed`.
- **Auth** is the `X-API-Key` header (partner keys); the older JWT flow is not
  used.
- **Evidence** for the ledger comes from the status response: destination tx
  hash, intent hashes and the quote signature.

## 7. Security model

- **No keys in Crewpay.** Signing happens in the TEE; Crewpay holds only a
  `wk_` API key. Compromise of the app server cannot extract a key, and the
  enclave re-checks the wallet's on-chain policy before every signature.
- **Two independent policy layers.** Crewpay's deterministic engine, then
  OutLayer's manifest. A bug in one does not by itself authorize a payment.
- **Defence against prompt injection.** The LLM planner cannot sign and cannot
  reach rails. Its output is a proposal that must pass policy, so a hijacked
  prompt can at worst propose a denied operation.
- **Idempotency.** Every operation carries a deterministic id, and the signer
  derives its `X-Idempotency-Key` from it, so a retry after a timeout returns
  the original request instead of moving funds twice.
- **Unknown fund state is never retried.** A funding failure is retried only
  when the service says no funds moved; anything unresolved is escalated to a
  human, because a blind retry can double-spend.
- **An approval authorises a payment, not a bypass.** Execution re-runs the
  policy engine, and a payee or policy change since the request makes the
  approval stale instead of paying. The operation is frozen at request time, so
  what the approver saw is what executes.
- **Least privilege.** API keys are scoped (`read`, `payroll:write`,
  `approvals:write`). Approvals require an `approver` member.
- **Auditability.** Decisions store the policy version; receipts link to chain
  evidence and TEE attestations.

## 8. Deployment

```
web (Next.js)        ─┐
api (Fastify)         ├─▶ Postgres (primary)  +  Redis (queue, locks)
agent worker (Node)  ─┘        │
                               └─▶ object storage (receipts, attestations, exports)
```

- `web`, `api`, `agent` deploy independently; the agent scales by queue depth.
- Postgres is the source of truth; Redis is disposable.
- All rail calls go through the agent worker, which is the only egress with
  rail credentials, and it runs with the narrowest possible scope.

## 9. Build order

1. **`policy` package** — pure engine + tests. Nothing ships without this.
2. **`ledger` package** — double-entry + receipts, tested against policy output.
3. **`api` skeleton** — orgs, payees, pay runs, approvals; wired to policy/ledger.
4. **`agent` worker** — start with a fake rail adapter, then swap in 1Click.
5. **1Click integration** — quote → sign → submit → status, with refunds.
6. **Signer (`packages/signer`)** — OutLayer TEE wallet funds the deposit and
   returns a `DepositProof`; four-way funding outcome so a retry never
   double-pays.
7. **Approval workflow** — `Approval` inbox with approve/reject/execute; a
   frozen operation, re-validated against the current policy at execution.
8. **Policy manifest** — `compileManifest` turns `PolicyRules` into an OutLayer
   manifest, warns on rules with no upstream equivalent, and diffs the wallet's
   effective policy for drift (`/v1/manifest`, `/v1/custody/approvals`).
9. **PingPay integration** — invoice checkout + webhook → auto pay run.
10. **Agent payees** — x402/MPP per-task settlement + 1099-style export.
11. **Treasury** — Earn, limit orders, sweeps.
12. **Accounting exports** — QuickBooks/Xero sync, attestation bundle.

## 10. Deliberately out of scope (v1)

- Crewpay-branded cards and credit lines (others own this).
- Selling the product *to* agents (ZeroClick/HitPay own discovery).
- Multi-entity consolidation and tax filing (export to a provider instead).
- Being a money transmitter: v1 is software that authorizes non-custodial
  movement; licensing comes later, corridor by corridor.
```
