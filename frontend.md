# CrewPay frontend — build brief

The console is a **TanStack Start** app at `apps/web/`. This document is the
contract for building on it: the stack, the design system, the data flow, and the
rules that must not break.

**Onboarding is the reference slice.** It is the only screen fully wired to the
CrewPay API, and `ONBOARDING.md` walks through it in detail. Read that first —
it contains the mapping pattern, the status-vocabulary fix, and the ordered plan
for every remaining screen.

The previous Next.js console is archived at git tag **`web-nextjs-archive`**. Use
it as reference for the screens this app does not have yet (agents, policy,
ledger, testnet) and for its API client, but do not restore its code — the
patterns here supersede it.

---

## 1. Scope and constraints

**Do not change:**
- Anything under `apps/api/`, `packages/`, or `scripts/`.
- `src/api/server-calls.js` — the token proxy. **Never bypass it.** See §6.
- The mapping contract in `src/api/crewpay.js` without updating its test.

**You own:** `apps/web/src/**` and all styling.

**Stack:** TanStack Start + TanStack Router, React 19, Vite, Tailwind CSS,
shadcn/ui (Radix primitives). JSX, not TSX — the app is JavaScript. `@` aliases
`src/`.

**Reads and writes:** components never call the API directly. Reads go through
`useRecords(entity)` → `apiList(path)`; writes through `src/lib/treasury.js` →
`apiPost(path, body)`. Both route through server functions that attach the bearer
token server-side. See §3.

---

## 2. What this product is (so the design lands)

CrewPay runs payroll and payouts for contractors, vendors, and **AI agents**. The
pitch that matters: **a pay run cannot overspend itself.** A deterministic policy
engine gates every line before money moves, and a double-entry ledger records
every outcome with on-chain proof.

Two implications:

- The audience is an **operator** (finance/ops). Dense, precise, scannable.
  Numbers are the content.
- The product's value is **trust and proof**. The UI should read like an audit
  tool: exact, calm, honest about state.

The single most important quality: **the UI must never imply money moved when it
did not.** The status vocabulary is load-bearing (§5), and so is the rule that an
empty screen never stands in for a failed fetch.

---

## 3. Data flow (the one pattern)

```
component
  └─ useRecords(entity)        reads:   src/hooks/useRecords.js
  └─ treasury.<write>()        writes:  src/lib/treasury.js
        └─ apiList / apiPost   src/api/server-calls.js   (server functions)
              └─ fetch(API_ORIGIN + path, Authorization: Bearer $CREWPAY_API_TOKEN)
        └─ toUi* / toServer*   src/api/crewpay.js        (pure mapping)
```

- **Server functions hold the token.** `server-calls.js` reads
  `process.env.CREWPAY_API_TOKEN` inside the handler; the framework replaces the
  body with an RPC stub on the client, so the browser never sees it.
- **Mapping is pure and tested.** `src/api/crewpay.js` has no imports, which is
  what lets `crewpay.test.js` run under plain `node --test`.
- **Unwired entities fail loudly.** `useRecords` throws for any entity not in
  `READERS`, and unwired writers call `notWired()` and throw. This is deliberate:
  a plausible empty table would claim the org has no data, when the truth is the
  screen is not connected. Preserve this property.

Currently wired: **`Payee` only** (`createPayee`, `setPayeeStatus`). Everything
else throws. `ONBOARDING.md` §2 has the full table and §7 the recipe to wire the
next entity.

---

## 4. The mapping contract

Copy `src/api/crewpay.js` exactly for every new entity:

1. **Server → UI spreads and adds aliases.** `toUiPayee` spreads `...p`, then
   adds `name`, `payee_ref`, `chain`, `asset`, `risk_score`. Spreading keeps
   every server field on the row so it can be sent back whole.
2. **UI → server is explicit.** `toServerPayee` names each field, so a display
   alias can never leak into a request body.
3. **Absent stays absent.** Optional fields are added conditionally, never as
   `undefined`, so a round-trip does not invent keys.
4. **Unknown is not zero.** An unscored risk is `null`, not `0` — a `0` renders
   as a passing check that never ran.

**Money rules:** USD crosses the wire as integer **cents**; format with
`money()` from `src/lib/format.js`. On-chain amounts are **strings** (serialised
bigint) and must never be `Number()`-ed for display logic.

**Org scoping:** every write carries `orgId: ORG_ID` (`org_1`). Another org's
record returns 404, not 403, by design. Do not try to enumerate.

---

## 5. Status vocabulary (do not invent synonyms)

`src/lib/status.js` maps `(kind, value)` to a label and tone. **Its keys were
written against the Base44 entity model and do not match the server's enums.**
Unknown values fall back to a neutral chip, so a mismatch renders as grey rather
than as an error and is invisible until you look for it.

`ONBOARDING.md` §6 has the verified table of every mismatch. Fix it **before**
building any new screen. In short:

- `decision` should be `allow` / `allow_with_approval` / `deny` — not
  `settle` / `hold` / `deny`.
- `line` should follow `OperationStatus`: `proposed`, `denied`,
  `awaiting_approval`, `approved`, `signing`, `submitted`, `settled`, `failed`,
  `refunded`.
- `run` should follow `PayRunStatus`: `draft`, `planning`, `awaiting_approval`,
  `executing`, `settled`, `partially_settled`, `failed`.
- `invoice` should follow `InvoiceStatus`: `open`, `paid`, `expired`,
  `cancelled`, `failed` — there is no `void`.
- `worklist` should follow `FundingRecord.kind`: `pending`, `failed`,
  `needs_review`. There is no `resolved` row state — resolved rows are filtered
  out server-side.

Keep `statusMeta` returning the raw value when unmapped, so an unknown status is
visibly unmapped. Give `refunded` a deliberate tone: a refund is a
money-relevant outcome, not neutral.

---

## 6. Security rules (breaking these breaks the product)

1. **Never expose the API token to the browser.** It lives in
   `CREWPAY_API_TOKEN`, read only inside server functions. No `VITE_` or
   `NEXT_PUBLIC_` variant. All browser traffic goes through `apiList`/`apiPost`.
2. **Never log or render the token**, a `wk_` custody key, or any secret.
3. **Do not widen CORS** or add a proxy that forwards the token elsewhere.
4. If a value looks like a secret, treat it as one and ask.

---

## 7. Design system

Tokens live in `src/index.css` as HSL CSS variables (`:root` and `.dark`).
Tailwind reads them via `tailwind.config.js`, so use the semantic classes
(`bg-card`, `text-muted-foreground`, `border-border`) rather than raw colours.

- `--background` `220 22% 97%` · `--foreground` `222 32% 11%`
- `--primary` `243 70% 59%` (indigo/violet) · `--accent` `243 90% 97%`
- `--destructive` `0 72% 51%` · `--muted-foreground` `220 9% 45%`
- `--radius` `0.875rem` · `--border` `220 15% 90%`

Fonts (`src/routes/__root.jsx`): **Instrument Sans** (UI), **IBM Plex Mono**
(ids, addresses, amounts). A `.dark` theme is defined.

Shell: fixed 248px sidebar on `lg`, a `Sheet` drawer on mobile, `max-w-[1280px]`
content column, `card-surface` panels, and `PageHeader` for the eyebrow/title/
description/actions block. Nav is data-driven in `src/components/shell/nav.js`.

Non-negotiable:

- **Amounts are tabular.** Use the `tabular` class so money columns align.
- **Long ids/addresses truncate in the middle** with `shortHex()`, never wrap.
- **Every async action has pending / success / error states.** No dead buttons.
- **Empty states say what would appear here**, not just "No data".
- **Keyboard focus is always visible.** Do not remove focus rings.
- **Contrast meets WCAG AA** (4.5:1 body, 3:1 large) in both themes.

---

## 8. Screens

Routes are fixed. Redesigning appearance and completeness, not URLs.

| Screen | Route | Reads | Status |
|---|---|---|---|
| Overview | `/app` | PayRun, Approval, WorklistItem, PayRunLine | not wired |
| Pay runs | `/app/pay-runs` | PayRun, Payee, PayRunLine | not wired |
| Approvals | `/app/approvals` | Approval | not wired |
| Worklist | `/app/worklist` | WorklistItem | not wired |
| **Payees** | `/app/payees` | **Payee** | **wired** |
| Invoices | `/app/invoices` | Invoice, Payee | not wired |

**Missing entirely** (present in `web-nextjs-archive`): agent tasks, policy,
ledger, testnet. Ledger and policy are the differentiators — do not ship without
them.

Per screen, `ONBOARDING.md` §8 gives the build order and §9 the definition of
done.

---

## 9. States you must handle

Every screen fetches live data. There are no fixtures: **an empty store renders
empty screens, and a failed fetch renders an error, never a zero.**

Per screen: **loading** (skeleton/`LoadingRow`), **empty** (`EmptyState`),
**error** (a `Notice`, with the API-down case named), **partial** (a run with
some lines settled and some held).

---

## 10. Definition of done

- `npm run web:build` passes.
- `node --test apps/web/src/api/crewpay.test.js` passes.
- Status keys match the server enums, and an unknown status renders unmapped.
- Unwired entities still throw and are named by the route boundary.
- No token or secret in any client bundle or log.
- Every screen handles loading, empty, error, and partial states.

---

## 11. How to run it

```bash
npm run web:build     # build the console (Vite → apps/web/dist)
npm run api           # control plane on :4000
npm run web           # dev server on :3000
```

Both the API and the web process need `CREWPAY_API_TOKEN`; the web process also
reads `API_ORIGIN` (default `http://127.0.0.1:4000`).

**Known follow-up:** `scripts/redeploy.sh` still starts the old Next.js app
(`next start`) and checks `/_next/static/*.css`. The new app is Vite/TanStack and
serves `dist/client`. The script's start command and stylesheet check must be
rewritten before the deployed console is this one.
