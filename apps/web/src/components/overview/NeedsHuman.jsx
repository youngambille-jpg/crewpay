import { Link } from "@tanstack/react-router";
import { ChevronRight, CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { dotClass } from "@/lib/status";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";

export default function NeedsHuman({ items, loading }) {
  if (loading) return <LoadingRow label="Reading the queue…" />;
  if (!items?.length) {
    return (
      <EmptyState
        icon={CircleCheck}
        title="Nothing needs a human"
        note="No pending approvals and no unresolved funding requests."
      />
    );
  }

  return (
    <ul className="divide-y hairline">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to={item.href}
            className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/60 sm:px-5"
          >
            <span className={cn("mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full", dotClass(item.tone))} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] font-medium text-foreground">{item.title}</span>
                {item.amount && (
                  <span className="shrink-0 font-mono text-[11px] tabular text-muted-foreground">{item.amount}</span>
                )}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
                {item.reason}
              </span>
            </span>
            <ChevronRight
              className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-muted-foreground"
              strokeWidth={1.8}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}