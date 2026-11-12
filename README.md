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
| `packages/rails` | **done** | 51 | `SettlementRail` + `FakeRail`, 1Click adapter, PingPay checkout/webhook, Agent Pay (x402 + MPP) |
| `packages/signer` | **done** | 45 | OutLayer TEE custody, manifest compile + drift, four-way funding outcome |
| `apps/agent` | **done** | 26 | Orchestrator: pay runs and per-task agent payouts |
| `apps/api` | **done** | 39 | Control plane over `node:http`, in-memory store |

**182 tests, `tsc` clean.**

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
npm test           # 182 tests across policy, ledger, rails, signer, agent and api
npm run demo       # end-to-end pay run against the FakeRail + FakeSigner
npm run test:signer    # signer outcome, manifest and idempotency tests only
npm run verify:tokens  # check the pinned asset table against live 1Click
npm run typecheck  # strict tsc, no emit
```

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
POST   /v1/invoices                    issue an invoice (PingPay checkout)
GET    /v1/invoices                    invoices (?orgId=)
POST   /v1/webhooks/pingpay            payment settled -> trigger pay run / reconcile
POST   /v1/agent-tasks                 pay an agent per task (x402 quote/deposit/settle)
GET    /v1/agent-tasks                 agent tasks (?orgId=)
GET    /v1/exports/agent-payments      1099-style roll-up by payee (?orgId=&year=)
```

Planned but not yet implemented: `POST /v1/webhooks/1click` (swap status
transitions) and `GET /v1/ledger` (journal export + attestations).

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
