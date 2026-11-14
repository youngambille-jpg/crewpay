import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import StatusChip from "@/components/common/StatusChip";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import { money } from "@/lib/format";
import { ArrowLeftRight } from "lucide-react";

export default function RecentRuns({ runs, loading }) {
  if (loading) return <LoadingRow label="Loading runs…" />;
  if (!runs?.length) {
    return <EmptyState icon={ArrowLeftRight} title="No pay runs yet" note="Create your first run to see it here." />;
  }

  return (
    <ul className="divide-y hairline">
      {runs.map((run) => (
        <li key={run.id}>
          <Link
            to="/app/pay-runs"
            search={{ run: run.id }}
            className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/60 sm:px-5"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-mono text-[12px] font-medium text-foreground">{run.run_ref}</span>
                <StatusChip kind="run" value={run.status} />
              </span>
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                {run.period} · {run.line_count} {run.line_count === 1 ? "line" : "lines"}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-mono text-[12.5px] font-medium tabular">{money(run.total_cents)}</span>
            </span>
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-200 group-hover:translate-x-0.5"
              strokeWidth={1.8}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}