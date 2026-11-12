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
POST   /v1/approvals/:id/approve       one-signature owner approval
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
TEE-held wallet. Crewpay:

1. submits the operation to the policy engine;
2. on `allow`, asks OutLayer to sign/execute under the org's policy manifest;
3. on `allow_with_approval`, opens an OutLayer task (owner inbox) and waits;
4. records the attestation and transparency proof against the ledger entry.

OutLayer gives us TEE-held multi-chain wallets, a policy engine, multisig
approvals, gasless payment checks, confidential NEAR Intents, and on-chain
attestation. Crewpay's own policy engine runs *before* OutLayer's, so OutLayer
is the second line of defence and the custody boundary.

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

| Need | Rail | Concrete calls |
| --- | --- | --- |
| Cross-chain payout | NEAR Intents 1Click | `POST /v0/quote`, `/v0/status`, `/v0/generate-intent`, `/v0/submit-intent`, `appFees`, `refundTo` |
| Fund without on-chain wait | 1Click Intents | `depositType: INTENTS`, signed intent execution |
| Privacy for sensitive pay | 1Click confidential | `confidentiality` / `CONFIDENTIAL_INTENTS` |
| Fiat collection / invoicing | PingPay | hosted checkout, headless payments, subscriptions, onramp, webhooks |
| Agent paywalls / per-task pay | PingPay Agent Pay | x402 (`/agentpay/x402`), MPP (`/agentpay/mpp/charge`) |
| Custody, policy, approvals, attestation | OutLayer | TEE wallets, policy manifest, tasks/inbox, payment checks, transparency proofs |
| Yield on idle treasury | 1Click Earn | Earn endpoints |
| Screening | SHIELD / provider | incident + screening checks before `allow` |

## 7. Security model

- **No keys in Crewpay.** Signing happens in the TEE; Crewpay holds only
  references. Compromise of the app server cannot move funds.
- **Two independent policy layers.** Crewpay's deterministic engine, then
  OutLayer's manifest. A bug in one does not by itself authorize a payment.
- **Defence against prompt injection.** The LLM planner cannot sign and cannot
  reach rails. Its output is a proposal that must pass policy, so a hijacked
  prompt can at worst propose a denied operation.
- **Idempotency.** Every operation carries a deterministic id; deposits and
  submissions are idempotent so retries cannot double-pay.
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
6. **OutLayer integration** — TEE wallet, policy manifest, tasks for approvals.
7. **PingPay integration** — invoice checkout + webhook → auto pay run.
8. **Agent payees** — x402/MPP per-task settlement + 1099-style export.
9. **Treasury** — Earn, limit orders, sweeps.
10. **Accounting exports** — QuickBooks/Xero sync, attestation bundle.

## 10. Deliberately out of scope (v1)

- Crewpay-branded cards and credit lines (others own this).
- Selling the product *to* agents (ZeroClick/HitPay own discovery).
- Multi-entity consolidation and tax filing (export to a provider instead).
- Being a money transmitter: v1 is software that authorizes non-custodial
  movement; licensing comes later, corridor by corridor.
```
