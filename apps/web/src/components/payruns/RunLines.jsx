import { money, shortHex } from "@/lib/format";
import { reasonLabels } from "@/lib/policy";
import StatusChip from "@/components/common/StatusChip";
import Panel from "@/components/common/Panel";
import LoadingRow from "@/components/common/LoadingRow";
import EmptyState from "@/components/common/EmptyState";
import { CircleSlash } from "lucide-react";

export default function RunLines({ run, lines, loading }) {
  return (
    <Panel
      title={run ? `Lines · ${run.run_ref}` : "Lines"}
      description={
        run
          ? `${run.period} · ${run.settled_count ?? 0} settled · ${run.held_count ?? 0} held · ${run.denied_count ?? 0} denied`
          : "Select a run to see each line's decision."
      }
      action={
        <span className="hidden font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground sm:inline">
          decided server-side
        </span>
      }
    >
      {!run && <EmptyState icon={CircleSlash} title="No run selected" note="Pick a run in the table to inspect it." />}
      {run && loading && <LoadingRow label="Loading decisions…" />}
      {run && !loading && (
        <ul className="divide-y divide-border/60">
          {lines.map((line) => (
            <li key={line.id} className="px-4 py-3 transition-colors hover:bg-secondary/40 sm:px-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{line.payee_name}</span>
                    <StatusChip kind="decision" value={line.decision} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {reasonLabels(line.reason_codes).map((reason) => (
                      <span
                        key={reason}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.04em] text-muted-foreground"
                      >
                        {reason}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[12.5px] font-medium tabular">{money(line.amount_cents)}</div>
                  <div className="mt-1.5">
                    <StatusChip kind="line" value={line.status} />
                  </div>
                </div>
              </div>
              {line.tx_hash && (
                <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
                  tx {shortHex(line.tx_hash, 12, 8)}
                </div>
              )}
              {line.note && (
                <div className="mt-2 text-[10.5px] leading-relaxed text-rose-600">{line.note}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}