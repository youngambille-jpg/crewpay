import { BookOpen, FileText } from "lucide-react";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import { journalKindLabel } from "@/lib/status";

function PostingLine({ posting }) {
  const debit = posting.direction === "debit";
  return (
    <div className="flex items-baseline gap-2">
      <span className={`w-10 shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] ${debit ? "text-indigo-600" : "text-amber-700"}`}>
        {posting.direction}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={posting.account}>
        {posting.account}
      </span>
      {/* Base units at the asset's own scale: exact, never rounded. */}
      <span className="shrink-0 font-mono text-[11.5px] tabular">{posting.amount}</span>
      <span className="w-10 shrink-0 text-right font-mono text-[10px] uppercase text-muted-foreground">
        {posting.currency}
      </span>
    </div>
  );
}

/**
 * The books. Amounts are base-unit strings at each asset's own scale, so they
 * are shown exactly as recorded and never `Number()`-ed into a dollar figure —
 * the asset's decimals are not carried in the entry, and converting would be a
 * guess on an accountant's ledger.
 */
export default function LedgerTables({ ledger, loading }) {
  if (loading) return <LoadingRow label="Reading the books…" />;

  const entries = ledger?.entries ?? [];
  const trialBalance = ledger?.trialBalance ?? [];

  return (
    <div className="space-y-4">
      <section className="card-surface overflow-hidden">
        <header className="flex items-center justify-between border-b hairline px-4 py-3.5 sm:px-5">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">Trial balance</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Every account, netted per currency. Must sum to zero.</p>
          </div>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
            {ledger?.accountCount ?? 0} accounts
          </span>
        </header>

        {trialBalance.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No accounts yet"
            note="Run a pay run to write the first entries."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="border-b hairline bg-secondary/40">
                  {["Account", "Currency", "Debit", "Credit", "Balance"].map((head, index) => (
                    <th
                      key={head}
                      className={`px-4 py-2.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:px-5 ${
                        index >= 2 ? "text-right" : ""
                      }`}
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trialBalance.map((row) => (
                  <tr key={`${row.currency}-${row.account}`} className="border-b hairline last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-[12px] sm:px-5">{row.account}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] uppercase text-muted-foreground sm:px-5">
                      {row.currency}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular text-muted-foreground sm:px-5">{row.debit}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular text-muted-foreground sm:px-5">{row.credit}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-medium tabular sm:px-5">{row.balance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card-surface overflow-hidden">
        <header className="flex items-center justify-between border-b hairline px-4 py-3.5 sm:px-5">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">Journal entries</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Each entry balances on its own, per currency.</p>
          </div>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
            {entries.length} entries
          </span>
        </header>

        {entries.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No journal entries yet"
            note="A settled payment writes a payroll accrual and a settlement entry."
          />
        ) : (
          <ul className="divide-y hairline">
            {entries.map((entry) => (
              <li key={entry.id} className="px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10.5px] font-medium">
                      {journalKindLabel(entry.kind)}
                    </span>
                    <span className="truncate font-mono text-[11.5px] text-muted-foreground" title={entry.id}>
                      {entry.id}
                    </span>
                  </div>
                  <span className="font-mono text-[10.5px] text-muted-foreground">{entry.memo}</span>
                </div>
                <div className="mt-2 space-y-1">
                  {entry.postings.map((posting, index) => (
                    <PostingLine key={`${entry.id}-${index}`} posting={posting} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
