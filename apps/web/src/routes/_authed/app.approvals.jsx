import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import PageHeader from "@/components/common/PageHeader";
import Panel from "@/components/common/Panel";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import ApprovalsTable from "@/components/approvals/ApprovalsTable";
import { decideApproval } from "@/lib/treasury";
import { money } from "@/lib/format";
import useRecords from "@/hooks/useRecords";

export const Route = createFileRoute("/_authed/app/approvals")({
  component: ApprovalsPage,
});

const COPY = {
  approve: {
    title: "Approve this payment?",
    confirm: "Approve",
    tone: "default",
    body: (approval) =>
      `${approval.payee_name} · ${money(approval.amount_cents)} becomes executable. No funds move until you execute it.`,
  },
  reject: {
    title: "Reject this payment?",
    confirm: "Reject",
    tone: "danger",
    body: (approval) =>
      `${approval.payee_name} · ${money(approval.amount_cents)} will be denied. This decision is terminal for the line.`,
  },
  execute: {
    title: "Release funds now?",
    confirm: "Execute",
    tone: "danger",
    body: (approval) =>
      `${money(approval.amount_cents)} leaves for ${approval.payee_name}'s destination. Executing cannot be undone.`,
  },
};

function ApprovalsPage() {
  const { items, loading, reload } = useRecords("Approval");
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => {
    const rank = { pending: 0, approved: 1 };
    return [...items].sort(
      (a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || String(b.created_date).localeCompare(String(a.created_date)),
    );
  }, [items]);

  const actionable = items.filter((item) => item.status === "pending").length;

  async function confirm() {
    setBusy(true);
    try {
      await decideApproval(pending.approval, pending.action, "operator");
      const label = pending.action === "execute" ? "released" : pending.action === "approve" ? "approved" : "rejected";
      toast.success(`${pending.approval.approval_ref} ${label}`);
      setPending(null);
      await reload();
    } catch (error) {
      toast.error(error?.message || "Could not update this approval");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Decision inbox"
        title="Approvals"
        description="Every hold carries the policy id and version that produced it, so any decision can be replayed."
        actions={
          <span className="rounded-xl border hairline bg-white px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
            {actionable} actionable
          </span>
        }
      />

      <Panel
        title="Inbox"
        description="Only pending rows are actionable — executed, rejected and stale rows are terminal."
      >
        <ApprovalsTable
          approvals={sorted}
          loading={loading}
          busyId={busy ? pending?.approval?.id : null}
          onAction={(action, approval) => setPending({ action, approval })}
        />
      </Panel>

      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? COPY[pending.action].title : ""}
        description={pending ? COPY[pending.action].body(pending.approval) : ""}
        confirmLabel={pending ? COPY[pending.action].confirm : ""}
        tone={pending ? COPY[pending.action].tone : "default"}
        busy={busy}
        onConfirm={confirm}
      />
    </>
  );
}