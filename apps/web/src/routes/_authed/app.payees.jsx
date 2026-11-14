import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import PageHeader from "@/components/common/PageHeader";
import Panel from "@/components/common/Panel";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import PayeesTable from "@/components/payees/PayeesTable";
import NewPayeeForm from "@/components/payees/NewPayeeForm";
import Notice from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { setPayeeStatus } from "@/lib/treasury";
import useRecords from "@/hooks/useRecords";

export const Route = createFileRoute("/_authed/app/payees")({
  component: PayeesPage,
});

function PayeesPage() {
  const { items: payees, loading, error, reload } = useRecords("Payee", {}, { sort: "name" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [blocking, setBlocking] = useState(null);

  async function applyStatus(payee, status) {
    setBusyId(payee.id);
    try {
      await setPayeeStatus(payee, status);
      toast.success(`${payee.name} ${status}`);
      setBlocking(null);
      await reload();
    } catch (error) {
      toast.error(error?.message || "Could not update the payee");
    } finally {
      setBusyId(null);
    }
  }

  const draftCount = payees.filter((payee) => payee.status === "draft").length;
  const payeeIds = payees.map((payee) => payee.id);

  return (
    <>
      <PageHeader
        eyebrow={`${payees.length} payees · ${draftCount} awaiting approval`}
        title="Payees"
        description="Destinations you can pay. A payee must be approved before any line can settle to it."
        actions={
          <Button className="h-9 rounded-xl lg:hidden" onClick={() => setSheetOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" strokeWidth={2.2} />
            Onboard
          </Button>
        }
      />

      {error ? (
        <Notice title="Could not load payees" tone="amber">
          {error.message} — check that the API is running, then reload.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]">
        <div className="min-w-0">
          <Panel title="Directory" description="Status and screening decide whether a payee is payable.">
            <PayeesTable
              payees={payees}
              loading={loading}
              busyId={busyId}
              onApprove={(payee) => applyStatus(payee, "approved")}
              onBlock={setBlocking}
            />
          </Panel>
        </div>

        <div className="hidden lg:block">
          <div className="card-surface sticky top-6 p-4">
            <h2 className="text-[15px] font-semibold tracking-tight">Onboard payee</h2>
            <p className="mb-3 mt-0.5 text-xs text-muted-foreground">Draft plus screening — then an approval.</p>
            <NewPayeeForm onCreated={reload} existingIds={payeeIds} />
          </div>
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-[420px]">
          <SheetHeader className="border-b hairline px-5 py-4 text-left">
            <SheetTitle className="text-[17px] tracking-[-0.01em]">Onboard payee</SheetTitle>
            <SheetDescription className="text-[12px]">Draft plus screening — then an approval.</SheetDescription>
          </SheetHeader>
          <div className="px-5 py-4">
            <NewPayeeForm
              onCreated={() => {
                setSheetOpen(false);
                reload();
              }}
              existingIds={payeeIds}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={Boolean(blocking)}
        onOpenChange={(open) => !open && setBlocking(null)}
        title="Block this payee?"
        description={blocking ? `${blocking.name} can no longer be paid. Live holds for this payee will fail policy.` : ""}
        confirmLabel="Block payee"
        tone="danger"
        busy={busyId === blocking?.id}
        onConfirm={() => applyStatus(blocking, "blocked")}
      />
    </>
  );
}