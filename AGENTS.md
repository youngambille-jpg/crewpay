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
```

There is no build step. There are no runtime dependencies in the core packages.

## Toolchain facts (important)

- **Node >= 22.6 runs `.ts` directly** via native type stripping. We rely on
  this: sources import each other with explicit `.ts` extensions and nothing is
  compiled. Do not add a bundler or ts-node.
- **Type stripping does not allow enum or namespace.** Use string-literal union
  types and plain objects (`as const`) instead.
- **`node --test` with no path arguments** discovers `*.test.ts`. Passing a
  directory path fails with MODULE_NOT_FOUND; pass a file path instead.
- **Workspace packages need an `exports` map** (`{".": "./src/index.ts"}`) or
  Node's ESM resolver falls back to `index.js` and fails. `apps/*` need this too
  if another package imports them.
- The toolchain is offline. `npm install` works from cache; adding a new
  dependency may not. Prefer the standard library.

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
  `OneClickRail`). Network only here.
- `apps/agent` — orchestration (`executeRun`): policy → rail → ledger.
- `apps/api` — control plane over `node:http`, in-memory store. Owns org state,
  never moves money itself.

## Status

Done and tested: `domain`, `policy`, `ledger`, agent orchestration, api skeleton.
Not started: live 1Click wiring, OutLayer signing, PingPay, x402/MPP agent
payouts, Postgres persistence, web UI.
