# Crewpay

Payroll and payouts for the agentic workforce. A policy-guarded agent runs a
company's global pay runs on stablecoin rails; payees are contractors, vendors,
and AI agents that get paid per completed task.

> One pay run. Your global contractors get paid in stablecoins on their own
> chain. Your AI agents get paid per task. You set the rules once and approve
> exceptions with one signature.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design of record.

## Architecture at a glance

The whole system in one picture. **The rails are a commodity; the
trust-and-books layer is the product** — so `policy`, `ledger` and the
settlement orchestration are the parts we own end to end.

```
                              ┌─────────────────────────────────────────────────────┐
                              │                      Crewpay                       │
                              │                                                     │
 payroll CSV / API  ─────────▶│  apps/api                                           │
 invoices           ─────────▶│  (control plane)                                    │
 PingPay webhooks   ─────────▶│      │                                              │
                              │      │  createPayRun / payAgentTask                 │
                              │      ▼                                              │
                              │  apps/agent  ──────────▶  packages/policy           │
                              │  (orchestrator)           deterministic gate        │
                              │      │                    no LLM, versioned         │
                              │      │                                              │
                              │      ├──────────▶  packages/rails                   │
                              │      │             SettlementRail + adapters        │
                              │      ├──────────▶  packages/signer                  │
                              │      │             TEE custody (OutLayer)           │
                              │      └──────────▶  packages/ledger                  │
                              │                    double-entry journal             │
                              │                                                     │
                              └───────┬──────────────────┬───────────────┬──────────┘
                                      │                  │               │
                    ┌─────────────────┼──────────────────┼───────────────┼──────────────┐
                    ▼                 ▼                  ▼               ▼              ▼
                  PingPay     NEAR Intents 1Click Agent Pay (x402)  OutLayer TEE   Payee wallets
                checkout +        cross-chain       / MPP charge      custody +     (any chain)
              agent paywalls      settlement        agent payouts    attestation
```

**Data flow in one line:** the api turns a source (pay run, invoice, agent task)
into an `Operation`; the agent evaluates it through the policy engine; allowed
operations settle through a rail funded by the TEE signer; every settlement
writes a balanced journal entry. Nothing moves money without a recorded policy
decision.

## What is in this repo today

Everything below is implemented and tested. The money logic runs end to end with
no network and no credentials, so it is reviewable before any rail is wired in.

| Package | Status | Tests | What it is |
| --- | --- | --- | --- |
| `packages/domain` | done | — | Types: money, payees, operations, pay runs, policies, invoices, agent tasks |
| `packages/policy` | **done** | 15 | The deterministic constraint engine (the moat) |
| `packages/ledger` | **done** | 6 | Double-entry journal with balanced-entry enforcement |
| `packages/rails` | **done** | 52 | `SettlementRail` + `FakeRail`, 1Click adapter, PingPay checkout/webhook, Agent Pay (x402 + MPP) |
| `packages/signer` | **done** | 45 | OutLayer TEE custody, manifest compile + drift, four-way funding outcome |
| `apps/agent` | **done** | 26 | Orchestrator: pay runs and per-task agent payouts |
| `apps/api` | **done** | 39 | Control plane over `node:http`, in-memory store |

**183 tests, `tsc` clean.**

## The three money flows

### 1. Pay run — pay contractors, vendors and agents in a batch

```
 POST /v1/pay-runs
        │
        ▼
 createPayRun ── per line ──▶  Operation
        │
        ▼
 agent.executeRun ──▶ policy.evaluate        (deterministic, versioned)
        │                    │
        │      deny ─────────┴──▶ recorded, no money moves
        │      allow_with_approval ──▶ approvals inbox (one signature)
        │      allow
        ▼
 settleOperation
        │   rail.quote ──▶ signer.plan/fund ──▶ rail.submit ──▶ rail.poll
        ▼
 ledger.paymentSettled          (balanced entry + on-chain proof)
```

One operation can end `settled`, `failed`, or `needs_review` — funding that is
in an unknown state stops rather than retrying and moving funds twice.

### 2. Invoice — get paid first, then pay out from the proceeds

```
 POST /v1/invoices ──▶ PingPay.createCheckout ──▶ hosted checkout URL
                                                        │
                                              customer pays (fiat/crypto)
                                                        │
                                                        ▼
 POST /v1/webhooks/pingpay ──▶ verify HMAC over raw bytes
        │
        ├─ dedupe on event id            (Ping retries until 2xx)
        └─ read session back from Ping   (the webhook is a claim, the session is truth)
                    │
                    ▼
              createPayRun ──▶ the *same* policy path as flow 1
```

A paid invoice opens a pay run through the identical `createPayRun` call, so a
large invoice is still held for approval exactly as a posted run would be.

### 3. Agent task — pay an agent per completed task over x402

```
 POST /v1/agent-tasks
        │
        ▼
 operationForTask ──▶ policy.evaluate        (same gate as payroll)
        │
        ▼
 agentpay.offers ──▶ agentpay.quote ──▶ depositAddress + operationToken
        │              (refundTo required, fails closed)
        ▼
 signer.fund(depositAddress)
        │
        ▼
 agentpay.settle(txHash) ──── same operationToken on every retry ────▶ receipt
        │                            ▲
        │      pending / INCOMPLETE ─┘        (the deposit exists; re-quoting
        ▼                                      would abandon in-flight funds)
 ledger.paymentSettled
```

An agent is not a special case of money: a task becomes an ordinary `Operation`,
so per-kind caps and approval thresholds apply identically. `pending` and
`INCOMPLETE_DEPOSIT` are distinct from failure, and a success with no
transaction hash is treated as unknown rather than settled.

## Requirements

- Node >= 22.6 (uses native TypeScript execution and `node --test`). Node 24 is
  what this was built against.

No build step and no runtime dependencies are needed for the core packages.

## Use

```bash
npm install        # links the workspace packages
npm test           # 183 tests across policy, ledger, rails, signer, agent and api
npm run demo       # end-to-end pay run against the FakeRail + FakeSigner
npm run test:signer    # signer outcome, manifest and idempotency tests only
npm run verify:tokens  # check the pinned asset table against live 1Click
npm run smoke:live     # run the real rails against live services (needs network)
npm run typecheck  # strict tsc, no emit
```

`smoke:live` is the one command here that touches the network, so it is
deliberately not part of `npm test`. It asserts that our parsers accept what the
live services actually return, on the paths that need no credentials: the 1Click
token list and a dry quote, Ping x402 discovery, and an OutLayer **testnet**
wallet (`POST /register` mints a throwaway one). Set `PING_API_KEY` to also
exercise the PingPay checkout and facilitator paths. It catches shape drift in
minutes and needs nothing from anyone.

The demo seeds four payees and runs one pay run. Expected result: one contractor
settles (with a deposit proof), one operation's funding is escalated to
`needsReview`, one vendor over the approval threshold opens an approval that is
then approved and executed, and one agent payee over the per-kind cap is denied.
It then prints the policy compiled to an OutLayer manifest, runs the invoice
flow (a Ping checkout session, settled by a signed webhook, opening a pay run),
and pays an agent for a task over x402, printing the 1099-style export.

### API surface

```
GET    /health                         liveness + which rail is wired
POST   /v1/payees                      create/upsert a payee
POST   /v1/policies                    publish a policy version (one active per org)
POST   /v1/pay-runs                    run a pay run (csv|api|invoice source)
GET    /v1/pay-runs                    list pay runs
GET    /v1/approvals                   approvals inbox (?orgId=&status=)
POST   /v1/approvals/:id/approve       one-signature approval
POST   /v1/approvals/:id/reject        reject
POST   /v1/approvals/:id/execute       pay an approved operation (re-checks policy)
GET    /v1/manifest                    compile the policy to an OutLayer manifest + drift
GET    /v1/custody/approvals           mirror the wallet's own multisig inbox
GET    /v1/custody/requests            unresolved funding requests (?orgId=)
GET    /v1/custody/requests/:id        re-read one request's true state (read-only)
POST   /v1/invoices                    issue an invoice (PingPay checkout)
GET    /v1/invoices                    invoices (?orgId=)
POST   /v1/webhooks/pingpay            payment settled -> trigger pay run / reconcile
POST   /v1/agent-tasks                 pay an agent per task (x402 quote/deposit/settle)
GET    /v1/agent-tasks                 agent tasks (?orgId=)
GET    /v1/exports/agent-payments      1099-style roll-up by payee (?orgId=&year=)
GET    /v1/ledger                      journal entries + trial balance + attestation (?orgId=)
```

### Not built: `POST /v1/webhooks/1click`

The roadmap called for an OutLayer `request_completed` webhook receiver. It is
deliberately not built, because the contract is not specified enough to build
safely.

The docs name the header (`X-Webhook-Signature`) and say it is HMAC-signed, but
never say **what bytes are signed, or which secret signs them**. Only the
*Inbox* webhook (a different surface, for task events) documents a scheme: the
HMAC-SHA256 of the body in hex, with a secret returned once by `PUT
/inbox/webhook`. The policy `webhook_url` that carries `request_completed`
exposes no secret in its schema at all.

Guessing here is not a small risk. A receiver that verifies against the wrong
string, or skips verification because the scheme is unclear, accepts a forged
"settled" event and releases money that never arrived. That is the exact failure
the PingPay webhook was written to avoid — and there the contract *was* clear.

So the reconciliation work went the safe way instead: `/v1/custody/requests`
keeps every unresolved funding request, and `/v1/custody/requests/:id` re-reads
the service's own row. That is pull-based, uses the documented `GET
/wallet/v1/requests/{id}`, and needs no assumption about a signature. A webhook
is an optimisation on top of this — it can be added once the signing contract is
confirmed, without changing the reconciliation model.

## Design rules

1. **The rails are a commodity; the trust-and-books layer is the product.**
   We do not re-implement settlement, custody, or fiat onramps.
2. **The agent proposes, policy disposes.** No money moves without a
   deterministic policy decision recorded against a policy version.
3. **No keys in Crewpay.** Signing happens in a TEE (OutLayer); this codebase
   holds a `wk_` API key, not secrets.
4. **Everything reconciles.** Every settlement writes a balanced journal entry
   linked to on-chain evidence.

## Roadmap

1. `policy` and `ledger` — done.
2. `api` and `agent` skeletons — done.
3. `OneClickRail` against the live 1Click API — done (spec-accurate, tested
   against recorded fixtures, asset table drift-guarded).
4. `signer`: OutLayer TEE custody funds the deposit and passes a `DepositProof`
   to `submit` — done (`packages/signer`, four-way funding outcome, idempotent).
5. Approvals inbox: frozen operation, approve/reject/execute, re-validated
   against the current policy at execution — done (`/v1/approvals`).
6. Policy manifest: `PolicyRules` compiled to an OutLayer manifest, with the
   wallet's effective policy read back and diffed for drift — done
   (`/v1/manifest`, `/v1/custody/approvals`).
7. PingPay invoices: hosted checkout + HMAC-verified webhook, read back before
   releasing money, and a paid invoice opens a pay run through the same policy
   path — done (`/v1/invoices`, `/v1/webhooks/pingpay`).
8. Agent payees: a task becomes an Operation and passes the same policy gate,
   then settles over x402 (quote → deposit → settle) with one token across
   retries — done (`/v1/agent-tasks`, `/v1/exports/agent-payments`).
9. Treasury: Earn, limit orders, sweeps. Accounting exports.
10. Ledger export: journal entries, a trial balance that must net to zero per
    currency, and a content-hash attestation — done (`/v1/ledger`). Journal
    entries are now persisted in the store; before this they were produced by
    the pay run and agent paths and then dropped, so there was nothing to
    export. The endpoint refuses (500) rather than report books containing an
    unbalanced entry.
11. Funding reconciliation: an unresolved funding request keeps its handle, so
    the true state can be re-read — done (`/v1/custody/requests`). This closed a
    real bug: `interpret()` computed the request id but dropped it on every
    `failed` branch, losing the handle in exactly the case where funds may have
    moved. The re-read is read-only on purpose; it never re-submits.
12. OutLayer `request_completed` webhook — see "Not built" above: the signing
    contract is underspecified, so this waits on confirmation rather than a
    guess.
