import { cn } from "@/lib/utils";
import { formatDate, money } from "@/lib/format";
import StatusChip from "@/components/common/StatusChip";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import { ArrowLeftRight } from "lucide-react";

const HEAD = ["Run", "Period", "Source", "Lines", "Value", "Status"];

export default function PayRunsTable({ runs, loading, selectedId, onSelect }) {
  if (loading) return <LoadingRow label="Loading pay runs…" />;
  if (!runs.length) {
    return <EmptyState icon={ArrowLeftRight} title="No pay runs yet" note="Create one to start a decision batch." />;
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b hairline bg-secondary/40">
              {HEAD.map((head) => (
                <th
                  key={head}
                  className="whitespace-nowrap px-4 py-2.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground first:pl-5"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {runs.map((run) => (
              <tr
                key={run.id}
                onClick={() => onSelect(run.id)}
                className={cn(
                  "cursor-pointer transition-colors hover:bg-secondary/50",
                  selectedId === run.id && "bg-indigo-50/70 hover:bg-indigo-50",
                )}
              >
                <td className="px-4 py-3 pl-5">
                  <div className="font-mono text-[12px] font-medium">{run.run_ref}</div>
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">{formatDate(run.created_date)}</div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[12px] text-muted-foreground">{run.period}</td>
                <td className="px-4 py-3 text-[12px] capitalize text-muted-foreground">{run.source}</td>
                <td className="px-4 py-3 font-mono text-[11.5px] tabular text-muted-foreground">{run.line_count}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] font-medium tabular">
                  {money(run.total_cents)}
                </td>
                <td className="px-4 py-3 pr-5">
                  <StatusChip kind="run" value={run.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border/60 md:hidden">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(run.id)}
              className={cn(
                "w-full px-4 py-3 text-left transition-colors",
                selectedId === run.id ? "bg-indigo-50/70" : "hover:bg-secondary/50",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] font-medium">{run.run_ref}</span>
                <StatusChip kind="run" value={run.status} />
              </div>
              <div className="mt-1.5 flex items-end justify-between gap-3">
                <span className="text-[11px] text-muted-foreground">
                  {run.period} · {run.line_count} lines
                </span>
                <span className="font-mono text-[12.5px] font-medium tabular">{money(run.total_cents)}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}