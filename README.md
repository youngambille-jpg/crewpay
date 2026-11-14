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
| `packages/ledger` | **done** | 11 | Double-entry journal with balanced-entry enforcement |
| `packages/rails` | **done** | 99 | `SettlementRail` + `FakeRail`, 1Click adapter, PingPay checkout/webhook, Agent Pay (x402 + MPP), `CrossChainRail`, NEP-366 `Relayer` |
| `packages/signer` | **done** | 56 | OutLayer TEE custody, manifest compile + drift, four-way funding outcome |
| `apps/agent` | **done** | 30 | Orchestrator: pay runs and per-task agent payouts |
| `apps/api` | **done** | 112 | Control plane over `node:http`, in-memory store, bearer-token auth + org ownership |
| `apps/web` | **done** | 35 | Operator console (TanStack Start + React 19), Payees + Policy + Ledger wired |

**358 tests, `tsc` clean.**

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
npm test           # 358 tests across policy, ledger, rails, signer, agent, api and web
CREWPAY_API_TOKEN=$(openssl rand -hex 32) npm run api   # serve the control plane (token required, live testnet)
npm run test:signer    # signer outcome, manifest and idempotency tests only
npm run verify:tokens  # check the pinned asset table against live 1Click
npm run smoke:live     # run the real rails against live services (needs network)
npm run typecheck  # strict tsc, no emit
npm run web        # operator console (TanStack Start) on http://localhost:3000
npm run web:build  # production build of the console

./scripts/redeploy.sh   # build (if needed), start both, verify every route
```

`redeploy.sh` is the way to bring the console up on a fresh container. It starts
both servers detached (`setsid`) so they are not reaped when the shell that
launched them exits — starting them by hand is why the public link goes dead
between sessions. It is safe to re-run.

`apps/web` is the operator console (TanStack Start + React 19, built with Vite)
and nothing else: `/` is a door page linking into `/app`. It is the only
component with a build step and the only one with runtime dependencies; the core
money packages stay dependency-free and are untouched by it.

The console is a real client of the API, not a mock: it reads the API through
same-origin server functions and its buttons perform real writes. **Only the
Payees screen is wired today** — every other entity throws rather than render a
plausible empty table, so an unwired screen fails loudly instead of looking like
an empty org. See `ONBOARDING.md` for the wiring plan. To use it, run both
processes:

```
CREWPAY_API_TOKEN=$(openssl rand -hex 32) npm run api   # control plane on :4000, live testnet
CREWPAY_API_TOKEN=$CREWPAY_API_TOKEN npm run web        # web app on :3000, same-origin server functions call the API
```

The two processes must share one token: the API requires it, and the web app
presents it on the browser's behalf. `scripts/redeploy.sh` does this for you.

Then open <http://localhost:3000/app>. There is no seed data: a fresh start
shows honest empty states, and the first run needs a published policy, an
approved payee, and — for testnet settlement — a funded testnet wallet. Set
`API_ORIGIN` if the API is not on port 4000.

`smoke:live` is the one command here that touches the network, so it is
deliberately not part of `npm test`. It asserts that our parsers accept what the
live services actually return, on the paths that need no credentials: the 1Click
token list and a dry quote, Ping x402 discovery, and an OutLayer **testnet**
wallet (`POST /register` mints a throwaway one). Set `PING_API_KEY` to also
exercise the PingPay checkout and facilitator paths. It catches shape drift in
minutes and needs nothing from anyone.

### API surface

```
GET    /health                         liveness + which rail is wired
POST   /v1/payees                      create/upsert a payee
POST   /v1/policies                    publish a policy version (one active per org)
POST   /v1/pay-runs                    run a pay run (csv|api|invoice source)
GET    /v1/pay-runs                    list pay runs
GET    /v1/pay-runs/:id                run + per-line states, decisions, receipts
GET    /v1/operations                  operations + policy decisions (?orgId=&status=)
GET    /v1/notifications               notification outbox (?orgId=)
POST   /v1/testnet/wallet              register the server-held testnet wallet
GET    /v1/testnet/wallet              testnet wallet balances (never the key)
POST   /v1/testnet/prepare             storage + mint + recipient registration
POST   /v1/testnet/pay-runs            pay run settling mock USDT on testnet
GET    /v1/approvals                   approvals inbox (?orgId=&status=)
POST   /v1/approvals/:id/approve       one-signature approval
POST   /v1/approvals/:id/reject        reject
POST   /v1/approvals/:id/execute       pay an approved operation (re-checks policy)
GET    /v1/manifest                    compile the policy to an OutLayer manifest + drift
GET    /v1/custody/approvals           mirror the wallet's own multisig inbox
GET    /v1/custody/requests            unresolved funding requests (?orgId=)
GET    /v1/custody/requests/:id        re-read one request's true state (read-only)
POST   /v1/custody/requests/:id/resolve  settle the loop: re-read, book only a real settlement
POST   /v1/invoices                    issue an invoice (PingPay checkout)
GET    /v1/invoices                    invoices (?orgId=)
POST   /v1/webhooks/pingpay            payment settled -> trigger pay run / reconcile
POST   /v1/agent-tasks                 pay an agent per task (x402 quote/deposit/settle)
GET    /v1/agent-tasks                 agent tasks (?orgId=)
GET    /v1/exports/agent-payments      1099-style roll-up by payee (?orgId=&year=)
GET    /v1/ledger                      journal entries + trial balance + attestation (?orgId=)
GET    /v1/live/health                 probe the real external services (1Click, OutLayer, Ping)
POST   /v1/connect                     provision a real custody wallet in the provider's enclave
GET    /v1/connect                     connected wallet, or not — never the key
GET    /v1/connect/handoff             302 to the provider's dashboard (carries the key, so never JSON)
POST   /v1/policies/publish            compile the org rules into an encrypted policy and sign it
POST   /v1/live/dry-run                ask the enclave what it would do with a real withdraw
GET    /v1/live/custody                the wallet's own policy state and balance, read back
```

### Live mode and the testnet path

The API has one mode: live on testnet. It registers an OutLayer testnet wallet
at boot and settles through the testnet rail and signer — no fake adapters in
the served path, so a green run means real mock-USDT moved on testnet. The
console exposes the whole path in one screen:

`/app/testnet` — register the wallet, fund it with testnet NEAR, prepare
(storage + mint + recipient registration), then pay and read the chain tx back.

PingPay checkout and Agent Pay wire up only when `PING_API_KEY` is set; without
it those routes answer 400 and the console says so. 1Click prices corridors via
dry quotes; OutLayer policy compile/dry-run endpoints remain available over the
API for the custody backstop.

### Wallets: two of them, and they are different

There are two wallets in this app and conflating them is the easiest way to
mislead someone about who holds a key.

- **Your NEAR wallet** (the top bar) is the operator's own account, signed in
  with **NEAR Connect** (`@hot-labs/near-connect`). NEAR's docs are explicit
  that the older `@near-wallet-selector/*` is deprecated and should not be used,
  so it is not used here. NEAR Connect loads each wallet's script from a shared
  manifest at runtime, so this app bundles no wallet code and never sees a key.
  Neither balances nor read-only calls come from the connector — its docs say so
  plainly — so both go through a `near-api-js` `JsonRpcProvider` against a public
  RPC node. Set `NEXT_PUBLIC_NEAR_NETWORK=mainnet` (default `testnet`) to switch
  chains, and `NEXT_PUBLIC_NEAR_RPC_URL` to override the node.
- **The custody wallet** (the `/app/testnet` screen) is CrewPay's enclave-held
  signer, minted by the API against OutLayer testnet. Its key never leaves the
  server; the UI sees only the public account id and its on-chain balances.

The app shell wraps every `/app` screen in the NEAR Connect provider, so the
wallet session survives navigation. Nothing about the wallet session is sent to
the API — it is the operator's identity at the wallet layer, not an API credential.

### Authentication

The API serves payroll and the books, so it requires a bearer token on every
route except `/health`, `/v1/live/health`, and the PingPay webhook (which carries
an HMAC signature instead, since Ping cannot present a token).

- `CREWPAY_API_TOKEN` — the token. There is no default: `serve.ts` refuses to
  start without it, because a default would mean an unauthenticated server.
- `CREWPAY_ORG_ID` — the org that token may act on (default `org_1`).

The token is a *client* credential, not a user login: it identifies the org, not
the human. Two people sharing one token are indistinguishable to the API.

The dashboard never sees the token. `/api/*` is served by a route handler
(`apps/web/app/api/[...path]/route.ts`) that attaches it server-side, so no
credential reaches the browser — which is why there is no `NEXT_PUBLIC_` token.
`scripts/redeploy.sh` generates one and gives it to both processes. It also
loads a gitignored `.env` if present (see `.env.example`), which is where
`PING_API_KEY` and `PING_WEBHOOK_SECRET` belong; `npm run api` and
`npm run smoke:live` load the same file via `node --env-file-if-exists=.env`.

Two limits are deliberate and are stated in the UI rather than papered over:

- **The policy is compiled and signed, but not yet stored on-chain.** Storing it
  needs a funded account, so the enclave reports `policy: "none"` and a dry-run
  that passes means *nothing refused it*, not yet that your limits allowed it.
- **No funds move.** The minted wallet holds nothing, so nothing can be
  broadcast from it. The rail is the fake one until a funded account is wired.

The custody handoff URL embeds the wallet's `wk_` API key, so it is never
serialised to a client: the dashboard links to `/v1/connect/handoff`, which
redirects server-side. `live.test.ts` asserts the key appears in no response body.

### Not built: `POST /v1/webhooks/1click`

The roadmap called for an OutLayer `request_completed` webhook receiver. It is
deliberately not built, because the contract is not specified enough to build
safely.

The docs name the `request_completed` event but never state **what signs it or
which secret is used**. This was re-verified by sweeping all 27 OutLayer doc
pages (`/docs/*`, from the sitemap):

- `X-Webhook-Signature` appears on exactly one page, the **tasks** doc — and it
  is a *different* webhook: the owner names an HTTPS URL on the inbox settings,
  and each request carries `X-Wallet-Id: owner:<account>` plus
  `X-Webhook-Signature`, "the HMAC-SHA256 of the body in hex under a secret made
  when the URL was named and shown to the owner once". That scheme is real and
  implementable, but it fires `task_created` / `task_answered` / `task_failed` /
  `task_expired` — task lifecycle, not wallet funding.
- The wallet `request_completed` event is mentioned once (agent-custody) with no
  scheme, no secret and no field to name a URL. `webhook_url` appears on no page
  at all.
- `X-Binding-Webhook-Secret` exists but runs the other way (partner → OutLayer
  lifecycle news), not OutLayer → us.

Guessing here is not a small risk. A receiver that verifies against the wrong
string, or skips verification because the scheme is unclear, accepts a forged
"settled" event and releases money that never arrived. That is the exact failure
the PingPay webhook was written to avoid — and there the contract *was* clear.

Worth noting the layer below agrees: the 1Click docs (NEAR Intents) document no
webhook either — swap status is tracked with `GET /v0/status`. Polling is the
documented path at both levels.

So the reconciliation work went the safe way instead: `/v1/custody/requests`
keeps every unresolved funding request, `/v1/custody/requests/:id` re-reads
the service's own row, and `POST /v1/custody/requests/:id/resolve` closes the
loop into the books. All three are pull-based, use the documented `GET
/wallet/v1/requests/{id}`, and need no assumption about a signature. A webhook
is an optimisation on top of this — it can be added once the signing contract is
confirmed, without changing the reconciliation model.

The subtlety the resolve step exists for: an OutLayer funding `success` means
the *deposit reached the rail*, not that the payee was paid. In a pay run an
unresolved funding returns before the rail is ever submitted, so a deposit can
land and settle with nobody watching. Booking a settlement on the deposit alone
would invent money movement. So resolve treats a confirmed deposit only as the
point at which it starts asking the rail — via the documented `GET /v0/status`
— whether the payee actually got paid, and writes the journal entry only when
the rail says `settled`. A bare funding `failed` is not proof the funds stayed
put, so it stays on the worklist for a human; only `refunded`/`rejected` (funds
provably back or never sent) close it. Resolve never re-submits: a `?retry=true`
is refused rather than silently ignored.

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
12. Close the reconciliation loop into the books — done (`POST
    /v1/custody/requests/:id/resolve`). A confirmed deposit is not a paid payee,
    so resolve follows it to the rail and books a settlement only when the rail
    reports `settled`. The record is marked resolved rather than deleted, so a
    retry after a lost response is idempotent, and resolved rows leave the
    worklist. The deposit quote travels with the funding record, because the
    deposit address inside it is the only key the rail answers a status for.
13. OutLayer `request_completed` webhook — see "Not built" above: the signing
    contract is underspecified, so this waits on confirmation rather than a
    guess.
