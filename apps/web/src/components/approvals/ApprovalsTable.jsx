import { formatDateTime, money } from "@/lib/format";
import { reasonLabels } from "@/lib/policy";
import StatusChip from "@/components/common/StatusChip";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";

function Actions({ approval, busy, onAction }) {
  if (approval.status === "pending") {
    return (
      <div className="flex items-center gap-1.5">
        <Button size="sm" className="h-7 rounded-lg px-2.5 text-[11px]" disabled={busy} onClick={() => onAction("approve", approval)}>
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 rounded-lg px-2.5 text-[11px]"
          disabled={busy}
          onClick={() => onAction("reject", approval)}
        >
          Reject
        </Button>
      </div>
    );
  }
  if (approval.status === "approved") {
    return (
      <Button size="sm" className="h-7 rounded-lg px-2.5 text-[11px]" disabled={busy} onClick={() => onAction("execute", approval)}>
        {busy ? "Executing…" : "Execute"}
      </Button>
    );
  }
  return <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">terminal</span>;
}

function ReasonList({ reasons }) {
  return (
    <div className="flex flex-wrap gap-1">
      {reasonLabels(reasons).map((reason) => (
        <span
          key={reason}
          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.04em] text-muted-foreground"
        >
          {reason}
        </span>
      ))}
    </div>
  );
}

export default function ApprovalsTable({ approvals, loading, busyId, onAction }) {
  if (loading) return <LoadingRow label="Loading approvals…" />;
  if (!approvals.length) {
    return <EmptyState icon={ShieldCheck} title="Inbox is clear" note="Nothing is waiting on a decision." />;
  }

  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b hairline bg-secondary/40">
              {["Approval", "Payee", "Amount", "Reasons", "Policy", "Status", ""].map((head, index) => (
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
            {approvals.map((approval) => (
              <tr key={approval.id} className="transition-colors hover:bg-secondary/40">
                <td className="px-3 py-3 pl-5">
                  <div className="font-mono text-[11.5px] font-medium">{approval.approval_ref}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{approval.run_ref}</div>
                </td>
                <td className="max-w-[150px] px-3 py-3">
                  <div className="truncate text-[12.5px] font-medium">{approval.payee_name}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{formatDateTime(approval.created_date)}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-mono text-[12px] font-medium tabular">
                  {money(approval.amount_cents)}
                </td>
                <td className="px-3 py-3">
                  <ReasonList reasons={approval.reasons} />
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <div className="font-mono text-[10px] text-foreground">{approval.policy_id}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{approval.policy_version}</div>
                </td>
                <td className="px-3 py-3">
                  <StatusChip kind="approval" value={approval.status} />
                </td>
                <td className="px-3 py-3 pr-5">
                  <Actions approval={approval} busy={busyId === approval.id} onAction={onAction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border/60 lg:hidden">
        {approvals.map((approval) => (
          <li key={approval.id} className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-muted-foreground">{approval.approval_ref}</div>
                <div className="mt-1 truncate text-[13.5px] font-medium">{approval.payee_name}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[13px] font-medium tabular">{money(approval.amount_cents)}</div>
                <div className="mt-1">
                  <StatusChip kind="approval" value={approval.status} />
                </div>
              </div>
            </div>
            <div className="mt-2">
              <ReasonList reasons={approval.reasons} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
                {approval.policy_id} {approval.policy_version}
              </span>
              <Actions approval={approval} busy={busyId === approval.id} onAction={onAction} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}