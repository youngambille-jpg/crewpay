import { createHash } from "node:crypto";
import type { JournalEntry, Posting } from "./journal.ts";
import { isBalanced } from "./journal.ts";

/**
 * A per-account, per-currency net. `balance` is signed: positive means the
 * account is net-debited, which is the normal side for an asset or an expense.
 * The same number is reported as `debit`/`credit` totals so a reader can check
 * the arithmetic without knowing which way an account normally runs.
 */
export interface TrialBalanceRow {
  readonly account: string;
  readonly currency: string;
  readonly debit: string;
  readonly credit: string;
  /** debit - credit, in smallest units. */
  readonly balance: string;
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[];
  /** True when every currency nets to exactly zero across all accounts. */
  readonly balanced: boolean;
  /** Currencies whose totals do not net to zero. Empty when balanced. */
  readonly unbalancedCurrencies: readonly string[];
}

function net(posting: Posting): bigint {
  return posting.direction === "debit" ? posting.amount : -posting.amount;
}

/**
 * Aggregate a set of entries into a trial balance. Entries are grouped by
 * account and currency, and the whole set is checked for a zero net per
 * currency. A single unbalanced entry is caught by `post`, but this catches the
 * case where the entries themselves are fine and the *set* is not — a missing
 * entry, or a duplicate one.
 */
export function trialBalance(entries: readonly JournalEntry[]): TrialBalance {
  const debit = new Map<string, bigint>();
  const credit = new Map<string, bigint>();
  const currencyNet = new Map<string, bigint>();
  const key = (account: string, currency: string) => `${currency}\u0000${account}`;

  for (const entry of entries) {
    for (const p of entry.postings) {
      const k = key(p.account, p.currency);
      const delta = net(p);
      if (delta >= 0n) debit.set(k, (debit.get(k) ?? 0n) + delta);
      else credit.set(k, (credit.get(k) ?? 0n) - delta);
      currencyNet.set(p.currency, (currencyNet.get(p.currency) ?? 0n) + delta);
    }
  }

  const accounts = new Set([...debit.keys(), ...credit.keys()]);
  const rows: TrialBalanceRow[] = [];
  for (const k of [...accounts].sort()) {
    const [currency, account] = k.split("\u0000") as [string, string];
    const d = debit.get(k) ?? 0n;
    const c = credit.get(k) ?? 0n;
    rows.push({
      account,
      currency,
      debit: d.toString(),
      credit: c.toString(),
      balance: (d - c).toString(),
    });
  }

  const unbalancedCurrencies = [...currencyNet.entries()]
    .filter(([, total]) => total !== 0n)
    .map(([currency]) => currency)
    .sort();

  return { rows, balanced: unbalancedCurrencies.length === 0, unbalancedCurrencies };
}

/**
 * A content hash over the entries, so an export can be pinned to an exact set
 * of books. The input is a canonical, order-independent string: entries sorted
 * by id, postings in their recorded order (which is meaningful), each field
 * length-prefixed so no two different ledgers can serialise the same way.
 */
export function attestation(entries: readonly JournalEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parts: string[] = [];
  const field = (v: string) => parts.push(`${v.length}:${v}`);
  for (const e of sorted) {
    field(e.id);
    field(e.orgId);
    field(e.kind);
    field(e.createdAt);
    for (const p of e.postings) {
      field(p.account);
      field(p.direction);
      field(p.amount.toString());
      field(p.currency);
    }
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Every entry in the set must balance, or the set is not safe to report on. */
export function allBalanced(entries: readonly JournalEntry[]): boolean {
  return entries.every((e) => isBalanced(e));
}
