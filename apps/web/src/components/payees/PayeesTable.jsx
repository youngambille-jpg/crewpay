import { shortHex } from "@/lib/format";
import { cn } from "@/lib/utils";
import StatusChip from "@/components/common/StatusChip";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import { Button } from "@/components/ui/button";
import { Users } from "lucide-react";

function Risk({ score }) {
  if (typeof score !== "number") {
    return <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">unscored</span>;
  }
  const value = score;
  const tone = value >= 70 ? "bg-rose-500" : value >= 45 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-10 overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <span className="font-mono text-[11px] tabular text-muted-foreground">{value}</span>
    </div>
  );
}

function Actions({ payee, busy, onApprove, onBlock }) {
  if (payee.status === "draft") {
    return (
      <Button size="sm" className="h-7 rounded-lg px-2.5 text-[11px]" disabled={busy} onClick={() => onApprove(payee)}>
        Approve
      </Button>
    );
  }
  if (payee.status === "approved") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-lg px-2.5 text-[11px] text-rose-600 hover:text-rose-700"
        disabled={busy}
        onClick={() => onBlock(payee)}
      >
        Block
      </Button>
    );
  }
  return <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">blocked</span>;
}

export default function PayeesTable({ payees, loading, busyId, onApprove, onBlock }) {
  if (loading) return <LoadingRow label="Loading payees…" />;
  if (!payees.length) return <EmptyState icon={Users} title="No payees yet" note="Onboard one to fund a line." />;

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b hairline bg-secondary/40">
              {["Payee", "Kind", "Destination", "Status", "Screening", "Risk", "Address", ""].map((head, index) => (
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
            {payees.map((payee) => (
              <tr key={payee.id} className="transition-colors hover:bg-secondary/40">
                <td className="px-3 py-3 pl-5">
                  <div className="max-w-[150px] truncate text-[12.5px] font-medium">{payee.name}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{payee.payee_ref}</div>
                </td>
                <td className="px-3 py-3 text-[11.5px] capitalize text-muted-foreground">{payee.kind}</td>
                <td className="whitespace-nowrap px-3 py-3 font-mono text-[10.5px] text-muted-foreground">
                  {payee.chain}:{payee.asset}
                </td>
                <td className="px-3 py-3">
                  <StatusChip kind="payee" value={payee.status} />
                </td>
                <td className="px-3 py-3">
                  <StatusChip kind="screening" value={payee.screening} />
                </td>
                <td className="px-3 py-3">
                  <Risk score={payee.risk_score} />
                </td>
                <td className="px-3 py-3 font-mono text-[10.5px] text-muted-foreground">{shortHex(payee.address, 6, 4)}</td>
                <td className="px-3 py-3 pr-5">
                  <Actions payee={payee} busy={busyId === payee.id} onApprove={onApprove} onBlock={onBlock} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border/60 md:hidden">
        {payees.map((payee) => (
          <li key={payee.id} className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium">{payee.name}</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {payee.payee_ref} · {payee.kind}
                </div>
              </div>
              <StatusChip kind="payee" value={payee.status} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] text-muted-foreground">
                {payee.chain}:{payee.asset} · {shortHex(payee.address, 6, 4)}
              </span>
              <Risk score={payee.risk_score} />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <StatusChip kind="screening" value={payee.screening} />
              <Actions payee={payee} busy={busyId === payee.id} onApprove={onApprove} onBlock={onBlock} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}