import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNTS, paymentSettled, payrollAccrual, post } from "./journal.ts";
import { allBalanced, attestation, trialBalance } from "./trial-balance.ts";

const USD = "usdc";

test("a trial balance nets each currency to zero and reports per-account totals", () => {
  const entries = [
    payrollAccrual({ id: "je_1", orgId: "org_1", amount: 100_000n, currency: USD, memo: "accrue" }),
    paymentSettled({ id: "je_2", orgId: "org_1", amount: 100_000n, currency: USD, memo: "settle" }),
  ];
  const tb = trialBalance(entries);
  assert.equal(tb.balanced, true);
  assert.deepEqual(tb.unbalancedCurrencies, []);

  const byAccount = new Map(tb.rows.map((r) => [r.account, r]));
  // Accrual debits expense, settlement debits payable: the expense stays
  // debited and the payable nets to zero once the payment clears.
  assert.equal(byAccount.get(ACCOUNTS.payrollExpense)!.balance, "100000");
  assert.equal(byAccount.get(ACCOUNTS.payrollPayable)!.balance, "0");
  assert.equal(byAccount.get(ACCOUNTS.clearing)!.balance, "-100000");
});

test("a trial balance is unbalanced when a currency does not net to zero", () => {
  // Bypass post() so an unbalanced entry can exist at all: this is the shape a
  // corrupted or truncated ledger would take.
  const broken = {
    id: "je_x",
    orgId: "org_1",
    kind: "payment_settled" as const,
    memo: "torn",
    createdAt: new Date().toISOString(),
    postings: [
      { account: ACCOUNTS.clearing, direction: "credit" as const, amount: 5n, currency: USD },
    ],
  };
  const tb = trialBalance([broken]);
  assert.equal(tb.balanced, false);
  assert.deepEqual(tb.unbalancedCurrencies, [USD]);
});

test("a fee splits correctly: payable and fee expense debit, clearing credits the sum", () => {
  const entry = paymentSettled({
    id: "je_3",
    orgId: "org_1",
    amount: 100_000n,
    fee: 250n,
    currency: USD,
    memo: "settle with fee",
  });
  assert.equal(allBalanced([entry]), true);
  const tb = trialBalance([entry]);
  const byAccount = new Map(tb.rows.map((r) => [r.account, r]));
  assert.equal(byAccount.get(ACCOUNTS.feeExpense)!.balance, "250");
  assert.equal(byAccount.get(ACCOUNTS.clearing)!.balance, "-100250");
});

test("attestation is stable across ordering and changes when the books change", () => {
  const a = payrollAccrual({ id: "je_1", orgId: "org_1", amount: 100_000n, currency: USD, memo: "m" });
  const b = paymentSettled({ id: "je_2", orgId: "org_1", amount: 100_000n, currency: USD, memo: "m" });
  const forward = attestation([a, b]);
  assert.equal(forward, attestation([b, a]), "insertion order must not change the hash");
  assert.notEqual(forward, attestation([a]));
  // The hash must bind amounts, not just ids: same ids, different money.
  const tampered = { ...a, postings: a.postings.map((p) => ({ ...p, amount: 1n })) };
  assert.notEqual(forward, attestation([tampered, b]));
});

test("attestation cannot be fooled by field boundaries", () => {
  // Two postings that would concatenate identically without length prefixes.
  const mk = (account: string, currency: string) =>
    post({
      id: "je_1",
      orgId: "org_1",
      kind: "refund",
      memo: "m",
      postings: [
        { account, direction: "debit", amount: 1n, currency },
        { account, direction: "credit", amount: 1n, currency },
      ],
    });
  assert.notEqual(attestation([mk("ab", "c")]), attestation([mk("a", "bc")]));
});
