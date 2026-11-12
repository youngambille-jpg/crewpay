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
| `packages/rails` | **done + tested** | `SettlementRail`, `FakeRail`, and a 1Click adapter written to the live spec |
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
npm install        # links the workspace packages
npm test           # 116 tests across policy, ledger, rails, signer, agent and api
npm run demo       # end-to-end pay run against the FakeRail + FakeSigner
npm run test:signer    # signer outcome, manifest and idempotency tests only
npm run verify:tokens  # check the pinned asset table against live 1Click
npm run typecheck  # strict tsc, no emit
```

The demo seeds four payees and runs one pay run. Expected result: one contractor
settles (with a deposit proof), one operation's funding is escalated to
`needsReview`, one vendor over the approval threshold opens an approval that is
then approved and executed, and one agent payee over the per-kind cap is denied.
It finishes by printing the policy compiled to an OutLayer manifest.

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
7. PingPay integration: invoice checkout + webhook → auto pay run.
8. Agent payees via x402/MPP per-task settlement.
9. Treasury: Earn, limit orders, sweeps. Accounting exports.
