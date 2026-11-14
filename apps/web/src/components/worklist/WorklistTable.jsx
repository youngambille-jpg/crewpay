import { formatDate } from "@/lib/format";
import StatusChip from "@/components/common/StatusChip";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import { Button } from "@/components/ui/button";
import { Inbox } from "lucide-react";

export default function WorklistTable({ items, loading, onOpen }) {
  if (loading) return <LoadingRow label="Loading open questions…" />;
  if (!items.length) {
    return <EmptyState icon={Inbox} title="Nothing unresolved" note="Every funding request has a confirmed outcome." />;
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b hairline bg-secondary/40">
              {["Request", "Operation", "Kind", "Reason", "Since", ""].map((head, index) => (
                <th
                  key={head || index}
                  className="whitespace-nowrap px-3 py-2.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground first:pl-5 last:pr-5"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {items.map((item) => (
              <tr key={item.id} className="transition-colors hover:bg-secondary/40">
                <td className="px-3 py-3 pl-5">
                  <div className="font-mono text-[11.5px] font-medium">{item.request_ref}</div>
                  <div className="mt-0.5">
                    <StatusChip kind="worklist" value={item.status} />
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-mono text-[11px] text-muted-foreground">
                  {item.operation_ref}
                </td>
                <td className="px-3 py-3 text-[12px] capitalize text-muted-foreground">{item.kind}</td>
                <td className="max-w-[280px] px-3 py-3">
                  <div className="truncate text-[12px]">{item.reason}</div>
                  {item.detail && <div className="truncate text-[10.5px] text-muted-foreground">{item.detail}</div>}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-[11.5px] text-muted-foreground">
                  {formatDate(item.created_date)}
                </td>
                <td className="px-3 py-3 pr-5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-lg px-2.5 text-[11px]"
                    onClick={() => onOpen(item)}
                  >
                    Review
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border/60 md:hidden">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpen(item)} className="w-full px-4 py-3.5 text-left">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11.5px] font-medium">{item.request_ref}</span>
                <StatusChip kind="worklist" value={item.status} />
              </div>
              <div className="mt-1.5 text-[12px] leading-snug">{item.reason}</div>
              <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                <span>
                  {item.kind} · {item.operation_ref}
                </span>
                <span>{formatDate(item.created_date)}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}