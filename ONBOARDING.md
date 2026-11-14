# Onboarding implementation plan

Slice 1 of rewiring the new console (TanStack Start) from Base44 onto the
CrewPay API. Onboarding is the first slice because it is already built and
working end to end — it is the reference pattern every other screen copies.

Read this before touching any other screen. Section 6 (status vocabulary) is a
prerequisite for all of them, not just this one.

---

## 1. What "onboarding" means here

Onboarding a payee = creating the record that says *who can be paid, on what
chain, to what address, and whether they are allowed to be paid yet.*

The flow has three states and one gate:

```
onboard (draft + review)  →  human approves (approved + clear)  →  payable
                            ↘  human blocks (blocked)           →  never payable
```

The gate is the point. A payee is not payable until a human approves it, and
policy refuses any line whose payee is not `approved`. Onboarding that skipped
the gate would let money move to an unreviewed destination — the exact thing the
product exists to prevent.

---

## 2. State of play (verified against the code)

The new app is TanStack Start + React 19 + Tailwind + shadcn/ui, at
`apps/web/`. It builds green. Its screens are:

| Screen | Route | Reads | Wired? |
|---|---|---|---|
| Overview | `/app` | PayRun, Approval, WorklistItem, PayRunLine | ✗ |
| Pay runs | `/app/pay-runs` | PayRun, Payee, PayRunLine | ✗ |
| Approvals | `/app/approvals` | Approval | ✗ |
| Worklist | `/app/worklist` | WorklistItem | ✗ |
| **Payees** | `/app/payees` | **Payee** | **✓** |
| Invoices | `/app/invoices` | Invoice, Payee | ✗ |

Reads resolve through `src/hooks/useRecords.js`; writes through
`src/lib/treasury.js`. **Only the `Payee` reader and `createPayee` /
`setPayeeStatus` are wired.** Every other function calls `notWired(name)` and
throws, and `useRecords` throws for any entity not in `READERS` — deliberately,
so an unwired screen fails loudly instead of rendering a plausible empty table.
Keep that property.

The old Next.js console is archived at git tag **`web-nextjs-archive`** if you
need to read its API client or its policy/ledger/testnet screens, which have no
counterpart here yet.

---

## 3. The onboarding slice as built

**Files**

- `src/routes/_authed/app.payees.jsx` — the screen. Table on the left; the form
  in a sticky panel on desktop and a `Sheet` on mobile. Owns `applyStatus`
  (approve/block), the `ConfirmDialog` for blocking, and reload.
- `src/components/payees/NewPayeeForm.jsx` — the onboarding form. Fields: id,
  name, kind, chain, asset, address. Busy state, success/error toasts, an id
  hint slug derived from the name.
- `src/components/payees/PayeesTable.jsx` — directory table + mobile list. Row
  actions: `draft` → **Approve**; `approved` → **Block**; `blocked` → no action.
- `src/api/crewpay.js` — pure mapping between server records and UI rows.
- `src/api/crewpay.test.js` — 6 tests over that mapping, `node --test`.
- `src/lib/treasury.js` — `createPayee`, `setPayeeStatus`.

**API contract used**

```
POST /v1/payees   create { id, kind, displayName, destination:{chain,asset},
                          address, status:"draft", screening:"review", orgId }
                  → 201 Payee
POST /v1/payees   update by upsert (same shape, changed status)
                  → 201 Payee
GET  /v1/payees   → Payee[]
```

**Why approve is an upsert, not a PATCH:** the server has no update endpoint.
`POST /v1/payees` does `store.payees.set(payee.id, payee)`, so posting the full
record with a changed `status` replaces it. `toServerPayee` exists precisely to
rebuild the exact record so the upsert does not drop fields. This is a
workaround, not a design — see §5.1.

---

## 4. The mapping layer is the pattern to copy

`src/api/crewpay.js` is the model for every other entity. Three rules:

1. **Mapping is pure and dependency-free.** No React, no fetch, no imports. That
   is what lets `crewpay.test.js` run under plain `node --test` with no build.
2. **Server → UI spreads the server record and adds display aliases.**
   `toUiPayee` spreads `...p` then adds `name`, `payee_ref`, `chain`, `asset`,
   `risk_score`. Spreading matters: it means the UI row still carries every
   server field, so it can be sent back whole.
3. **UI → server is explicit, never a spread.** `toServerPayee` names each
   field, so a display alias (`name`, `payee_ref`, `risk_score`) can never leak
   back into a request body.

Copy this shape for `toUiPayRun`, `toUiApproval`, `toUiInvoice`, etc. Write the
mapping test first — it is the cheapest place to catch a shape mismatch, and it
runs in 80ms.

**Money rules** (already true in the server, must hold in every mapping): USD
crosses the wire as integer **cents**; on-chain amounts are **strings**
(serialised bigint) and must never be `Number()`-ed for display logic.

---

## 5. Gaps in the onboarding slice

Close these before using onboarding as a template, or the pattern you copy will
carry the bugs.

### 5.1 Onboarding an existing id silently clobbers the record

`POST /v1/payees` is an unconditional `set` with no existence check, and returns
201 either way. `newPayeePayload` forces `status: "draft"`. So if a user
onboards a payee whose id already exists — a typo, a retry, a second operator —
the existing record is **overwritten**: its address is replaced and, if it was
`approved`, it is **demoted back to `draft`**. An approved payee silently
becomes unpayable, and a live destination can be swapped.

This is the highest-value fix in the slice. Options:

1. **UI guard (cheap, do now):** before `createPayee`, check the loaded `payees`
   for the id; if present, refuse with "that id already exists — pick another"
   and do not send. `NewPayeeForm` already receives the list via the page, so
   pass it down.
2. **Server guard (correct, needs a decision):** return 409 when the id exists.
   That is an API change — confirm before making it.

Do (1) regardless. It removes the footgun without touching the server.

### 5.2 The Risk column is always 0

`toUiPayee` reads `p.riskScore`, but nothing sets it: the form has no risk
field and the server does not score. So every onboarded payee shows `risk_score:
0` and a green bar — a risk signal that is *always* "safe" is worse than no
signal, because it looks like a check passed. Either hide the column until
something produces a score, or label it "unscored".

### 5.3 Screening has no workflow

Payees are created `screening: "review"` and `setPayeeStatus` flips it to
`clear` on approve. There is no way to record a `hit`, and no screening step —
the state is decorative. Approving therefore *asserts* "clear" without anything
having checked. For the demo this is fine; it must not read as a real screening
result. Say so in the UI copy, or wire a real check later.

### 5.4 No payee detail, edit, or history

You can approve, block, and onboard — nothing else. Cannot fix a typo'd address
without a clobber (§5.1), cannot see what a payee has been paid. A payee detail
view (record + their pay-run lines + their receipts) is the natural next step
after the write paths, and it is what makes the directory useful.

### 5.5 Email is dropped

`toServerPayee` copies `email` only if present, but `toUiPayee` never surfaces
it and the form has no field. Either add it end to end or stop half-supporting
it.

---

## 6. Status vocabulary must be reconciled first

**This blocks every screen, not just onboarding.** `src/lib/status.js` was
written against the Base44 entity model and its keys do not match the server's
enums. Unknown values fall back to a neutral slate chip — so mismatched statuses
render as grey, not as errors, and the mismatch is invisible until you look for
it.

Verified mismatches (`status.js` key → server enum):

| Kind | `status.js` has | Server actually has |
|---|---|---|
| `decision` | `settle`, `hold`, `deny` | `allow`, `allow_with_approval`, `deny` (`packages/policy/src/engine.ts`) |
| `line` | `settled`, `pending_approval`, `denied`, `failed` | `OperationStatus`: `proposed`, `denied`, `awaiting_approval`, `approved`, `signing`, `submitted`, `settled`, `failed`, `refunded` (`packages/domain/src/operation.ts`) |
| `run` | `draft`, `scheduled`, `processing`, `partially_settled`, `settled`, `failed` | `PayRunStatus`: `draft`, `planning`, `awaiting_approval`, `executing`, `settled`, `partially_settled`, `failed` (`packages/domain/src/payrun.ts`) |
| `invoice` | `draft`, `open`, `paid`, `void` | `InvoiceStatus`: `open`, `paid`, `expired`, `cancelled`, `failed` (`packages/domain/src/invoice.ts`) |
| `approval` | `pending`, `approved`, `rejected`, `executed`, `stale` | `ApprovalStatus`: adds `executing`, `failed` (`packages/domain/src/approval.ts`) |
| `worklist` | `needs_review`, `unsafe_failure`, `resolved` | `FundingRecord.kind`: `pending`, `failed`, `needs_review` (`apps/api/src/store.ts`) |

So: `scheduled`, `processing`, `void`, `pending_approval`, `unsafe_failure`,
`resolved`, `settle`, `hold` **never occur**; and `awaiting_approval`,
`executing`, `expired`, `cancelled`, `refunded`, `proposed`, `allow`,
`allow_with_approval` **have no entry** and render neutral.

Fix: rewrite `STATUS` to the server's exact enums, keyed by kind, and keep the
`statusMeta` fallback returning the raw value (so an unmapped status is visibly
unmapped, not silently grey). Give `refunded` a deliberate tone — a refund is a
money-relevant outcome, not a neutral one.

Two server-side truths to encode in the copy:

- A pay run's status is only ever `settled`, `partially_settled`, or
  `awaiting_approval` once it has run.
- A funding record has **no** `resolved` state in the worklist list: resolved
  rows are filtered out server-side. "Resolved" is a transient response from the
  resolve call, not a row state.

---

## 7. The recipe for the next entity

Onboarding proves the shape. For each remaining entity, in this order:

1. **Read the server endpoint** in `apps/api/src/server.ts` and the domain type
   in `packages/domain/src/`. Do not infer the shape from the Base44 screen.
2. **Write the mapping + its test** in `src/api/crewpay.js` /
   `crewpay.test.js`. Pure functions, no imports.
3. **Wire the reader** in `useRecords.js` `READERS`, mapping to a UI row.
4. **Wire the writers** in `treasury.js`, replacing `notWired`.
5. **Fix the status keys** for that entity in `status.js` (§6).
6. **Exercise it**: create → act → verify against `GET`, and confirm an unwired
   neighbour still fails loudly.

---

## 8. Ordered plan

**Slice 1 — Onboarding (harden, then done)**
1. Fix the id-clobber guard (§5.1 option 1). *Highest value.*
2. Resolve the Risk column (§5.2) and screening copy (§5.3).
3. Decide on email (§5.5).
4. Add a payee detail view (§5.4) once the other write paths exist.

**Slice 2 — Status vocabulary (§6).** Do this before any new screen. It is
small, it is verified, and every later slice depends on it.

**Slice 3 — Approvals.** The inbox is the product's centre of gravity, and it is
nearly wired already: `useRecords("Approval")` exists and only the write is
missing. Needs `decideApproval` (approve/reject) **and** execute — the server
keeps approval and execution as separate steps (`decide` then `execute`), and
the old console preserved that. Do not collapse them into one button.

**Slice 4 — Pay runs.** The largest slice: `createPayRun` (compose N lines),
`payRun(id)` for line outcomes, and `syncRun`. This is where money rules and the
`usdCents` vs base-unit-string distinction bite hardest.

**Slice 5 — Invoices.** `createInvoice` (returns a `checkoutUrl` that must be
reachable in the UI, not just shown once in a toast) and `markInvoicePaid`.

**Slice 6 — Worklist.** `resolveFunding` — and keep it **read-only**. It re-reads
the true state and never re-submits; show "still open" as a normal outcome.

**Slice 7 — Missing screens.** The new app has **no** agents, policy, ledger, or
testnet screens. Port them from `web-nextjs-archive` onto the new design system.
Ledger and policy are the differentiators; do not ship without them.

---

## 9. Definition of done (slice 1)

- Onboarding an id that already exists is refused in the UI and changes nothing
  server-side.
- Approve and block work, and an approved payee is then selectable in a pay run
  and an invoice.
- No screen shows a risk or screening signal that nothing produced.
- `node --test apps/web/src/api/crewpay.test.js` passes.
- `npm run web:build` passes.
- Unwired entities still throw and are named by the route boundary.

---

## 10. How to run it

```bash
npm run web:build     # build the console (Vite → apps/web/dist)
npm run api           # control plane on :4000
npm run web           # dev server on :3000
```

The console needs `CREWPAY_API_TOKEN` set for both the API and the web process,
and `API_ORIGIN` (default `http://127.0.0.1:4000`). The token is read inside the
server functions only — it must never reach the browser. `scripts/redeploy.sh`
still starts the **old** Next.js app and must be updated for this stack before
the deploy path works (see the follow-up below).

**Follow-up (not slice 1):** `scripts/redeploy.sh` starts `next start` and
checks `/_next/static/*.css`; the new app is Vite/TanStack and serves
`dist/client`. The script needs its start command and its stylesheet check
rewritten before the deployed console is this one.
