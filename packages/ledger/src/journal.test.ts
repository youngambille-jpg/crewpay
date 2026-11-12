import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNTS,
  assertBalanced,
  isBalanced,
  paymentSettled,
  payrollAccrual,
  post,
  treasuryConvert,
  UnbalancedEntryError,
} from "./journal.ts";

test("a balanced entry passes", () => {
  const entry = payrollAccrual({
    id: "je_1",
    orgId: "org_1",
    amount: 1_000_000n,
    currency: "usdc",
    memo: "pay run 2026-11",
  });
  assert.ok(isBalanced(entry));
  assert.equal(entry.postings.length, 2);
});

test("an unbalanced entry is rejected", () => {
  assert.throws(
    () =>
      post({
        id: "je_bad",
        orgId: "org_1",
        kind: "payroll_accrual",
        memo: "bad",
        postings: [
          { account: ACCOUNTS.payrollExpense, direction: "debit", amount: 5n, currency: "usdc" },
          { account: ACCOUNTS.payrollPayable, direction: "credit", amount: 4n, currency: "usdc" },
        ],
      }),
    UnbalancedEntryError,
  );
});

test("settlement with a fee stays balanced", () => {
  const entry = paymentSettled({
    id: "je_2",
    orgId: "org_1",
    amount: 990_000n,
    fee: 10_000n,
    currency: "usdc",
    memo: "op_1 settled",
  });
  assert.ok(isBalanced(entry));
  const fee = entry.postings.find((p) => p.account === ACCOUNTS.feeExpense);
  assert.equal(fee?.amount, 10_000n);
});

test("multi-currency conversion balances per currency", () => {
  const entry = treasuryConvert({
    id: "je_3",
    orgId: "org_1",
    fromAmount: 1_000_000n,
    fromCurrency: "usdt",
    toAmount: 999_000n,
    toCurrency: "usdc",
    memo: "convert surplus",
  });
  assert.ok(isBalanced(entry));
  assert.equal(entry.postings.length, 4);
});

test("a mixed-currency imbalance is caught", () => {
  assert.throws(
    () =>
      assertBalanced({
        postings: [
          { account: ACCOUNTS.treasury, direction: "debit", amount: 100n, currency: "usdc" },
          { account: ACCOUNTS.treasury, direction: "credit", amount: 100n, currency: "usdt" },
        ],
      }),
    UnbalancedEntryError,
  );
});

test("an empty entry is not balanced", () => {
  assert.equal(isBalanced({ postings: [] }), false);
});
