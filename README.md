# Crewpay

Payroll and payouts for the agentic workforce. A policy-guarded agent runs a
company's global pay runs on stablecoin rails; payees are contractors, vendors,
and AI agents that get paid per completed task.

> One pay run. Your global contractors get paid in stablecoins on their own
> chain. Your AI agents get paid per task. You set the rules once and approve
> exceptions with one signature.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## What is in this repo today

This is the skeleton, with the two parts that matter most implemented and tested:

| Package | Status | What it is |
| --- | --- | --- |
| `packages/domain` | done | Types: money, payees, operations, pay runs, policies |
| `packages/policy` | **done + tested** | The deterministic constraint engine (the moat) |
| `packages/ledger` | **done + tested** | Double-entry journal with balanced-entry enforcement |
| `packages/rails` | started | `SettlementRail` interface, `FakeRail`, 1Click adapter |
| `apps/agent` | started + tested | Pay-run orchestrator: policy → rail → ledger |
| `apps/api` | started + tested | Control plane over `node:http`, in-memory store |

The money logic runs end to end with no network and no credentials, so it is
testable and reviewable before any rail is wired in.

## Requirements

- Node >= 22.6 (uses native TypeScript execution and `node --test`). Node 24 is
  what this was built against.

No build step and no runtime dependencies are needed for the core packages.

## Use

```bash
npm install       # links the workspace packages
npm test          # 30 tests across policy, ledger, agent and api
npm run demo      # end-to-end pay run against the FakeRail
npm run typecheck # strict tsc, no emit
```

The demo seeds four payees and runs one pay run. Expected result: two
contractors settle, one vendor over the approval threshold goes to approval, and
one agent payee over the per-kind cap is denied.

## Design rules

1. **The rails are a commodity; the trust-and-books layer is the product.**
   We do not re-implement settlement, custody, or fiat onramps.
2. **The agent proposes, policy disposes.** No money moves without a
   deterministic policy decision recorded against a policy version.
3. **No keys in Crewpay.** Signing happens in a TEE (OutLayer); this codebase
   holds references, not secrets.
4. **Everything reconciles.** Every settlement writes a balanced journal entry
   linked to on-chain evidence.

## Roadmap

1. `policy` and `ledger` — done.
2. `api` and `agent` skeletons — done.
3. Wire `OneClickRail` to the live 1Click API (quote → sign → submit → status).
4. OutLayer integration: TEE wallet, policy manifest, approval tasks.
5. PingPay integration: invoice checkout + webhook → auto pay run.
6. Agent payees via x402/MPP per-task settlement.
7. Treasury: Earn, limit orders, sweeps. Accounting exports.
