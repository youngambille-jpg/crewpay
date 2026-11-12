import type { UsdCents } from "@crewpay/domain";

export type Direction = "debit" | "credit";

export interface Posting {
  readonly account: string;
  readonly direction: Direction;
  /** Exact smallest-unit amount; all postings in an entry share a currency. */
  readonly amount: bigint;
  readonly currency: string;
}

export type EntryKind =
  | "payroll_accrual"
  | "payment_settled"
  | "treasury_convert"
  | "fee_collected"
  | "refund"
  | "revenue";

export interface JournalEntry {
  readonly id: string;
  readonly orgId: string;
  readonly kind: EntryKind;
  readonly memo: string;
  readonly postings: readonly Posting[];
  readonly createdAt: string;
}

export class UnbalancedEntryError extends Error {
  constructor(entry: Pick<JournalEntry, "postings">) {
    const detail = entry.postings
      .map((p) => `${p.direction} ${p.amount.toString()} ${p.currency} ${p.account}`)
      .join(", ");
    super(`journal entry does not balance: ${detail}`);
    this.name = "UnbalancedEntryError";
  }
}

/** An entry is valid when, per currency, debits equal credits exactly. */
export function isBalanced(entry: Pick<JournalEntry, "postings">): boolean {
  const net = new Map<string, bigint>();
  for (const p of entry.postings) {
    const delta = p.direction === "debit" ? p.amount : -p.amount;
    net.set(p.currency, (net.get(p.currency) ?? 0n) + delta);
  }
  for (const total of net.values()) {
    if (total !== 0n) return false;
  }
  return net.size > 0;
}

export function assertBalanced(entry: Pick<JournalEntry, "postings">): void {
  if (!isBalanced(entry)) throw new UnbalancedEntryError(entry);
}

/**
 * Signs an entry and rejects it if it does not balance. This is the single
 * chokepoint through which all books must pass.
 */
export function post(entry: Omit<JournalEntry, "createdAt"> & { createdAt?: string }): JournalEntry {
  const signed: JournalEntry = {
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  assertBalanced(signed);
  return signed;
}

/** Chart of accounts used by the pay-run lifecycle. */
export const ACCOUNTS = {
  payrollExpense: "expense:payroll",
  payrollPayable: "liability:payroll_payable",
  clearing: "asset:stablecoin_clearing",
  feeExpense: "expense:payment_fees",
  treasury: "asset:treasury",
  fxClearing: "asset:fx_clearing",
} as const;

export function payrollAccrual(args: {
  id: string;
  orgId: string;
  amount: bigint;
  currency: string;
  memo: string;
}): JournalEntry {
  return post({
    id: args.id,
    orgId: args.orgId,
    kind: "payroll_accrual",
    memo: args.memo,
    postings: [
      { account: ACCOUNTS.payrollExpense, direction: "debit", amount: args.amount, currency: args.currency },
      { account: ACCOUNTS.payrollPayable, direction: "credit", amount: args.amount, currency: args.currency },
    ],
  });
}

export function paymentSettled(args: {
  id: string;
  orgId: string;
  amount: bigint;
  currency: string;
  fee?: bigint;
  memo: string;
}): JournalEntry {
  const fee = args.fee ?? 0n;
  return post({
    id: args.id,
    orgId: args.orgId,
    kind: "payment_settled",
    memo: args.memo,
    postings: [
      { account: ACCOUNTS.payrollPayable, direction: "debit", amount: args.amount, currency: args.currency },
      { account: ACCOUNTS.feeExpense, direction: "debit", amount: fee, currency: args.currency },
      { account: ACCOUNTS.clearing, direction: "credit", amount: args.amount + fee, currency: args.currency },
    ],
  });
}

/**
 * A treasury conversion is a trade, so it is booked with an FX clearing account
 * on each side. Each currency nets to zero on its own, which keeps the entry
 * balanced without inventing an exchange rate.
 */
export function treasuryConvert(args: {
  id: string;
  orgId: string;
  fromAmount: bigint;
  toAmount: bigint;
  fromCurrency: string;
  toCurrency: string;
  memo: string;
}): JournalEntry {
  return post({
    id: args.id,
    orgId: args.orgId,
    kind: "treasury_convert",
    memo: args.memo,
    postings: [
      { account: ACCOUNTS.treasury, direction: "debit", amount: args.toAmount, currency: args.toCurrency },
      { account: ACCOUNTS.fxClearing, direction: "credit", amount: args.toAmount, currency: args.toCurrency },
      { account: ACCOUNTS.fxClearing, direction: "debit", amount: args.fromAmount, currency: args.fromCurrency },
      { account: ACCOUNTS.treasury, direction: "credit", amount: args.fromAmount, currency: args.fromCurrency },
    ],
  });
}
