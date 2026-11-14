import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download, Plus } from "lucide-react";
import { toast } from "sonner";
import PageHeader from "@/components/common/PageHeader";
import Panel from "@/components/common/Panel";
import Notice from "@/components/common/Notice";
import InvoicesTable from "@/components/invoices/InvoicesTable";
import NewInvoiceForm from "@/components/invoices/NewInvoiceForm";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { money } from "@/lib/format";
import { downloadJournalCsv } from "@/lib/treasury";
import useRecords from "@/hooks/useRecords";
import { Webhook } from "lucide-react";

export const Route = createFileRoute("/_authed/app/invoices")({
  component: InvoicesPage,
});

function InvoicesPage() {
  const { items: invoices, loading, reload } = useRecords("Invoice");
  const { items: payees } = useRecords("Payee", {}, { sort: "name" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const payable = useMemo(() => payees.filter((payee) => payee.status === "approved"), [payees]);
  const openTotal = invoices
    .filter((invoice) => invoice.status === "open" || invoice.status === "pending")
    .reduce((sum, invoice) => sum + (invoice.amount_cents || 0), 0);

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadJournalCsv();
      toast.success("Journal exported");
    } catch (error) {
      toast.error(error?.message || "Could not export the journal");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`${money(openTotal)} outstanding`}
        title="Invoices"
        description="Send a pay page the customer opens to pay from any chain; settle to a payee when it clears."
        actions={
          <>
            <Button variant="outline" className="h-9 rounded-xl" onClick={exportCsv} disabled={exporting}>
              <Download className="mr-1.5 h-3.5 w-3.5" strokeWidth={2.2} />
              {exporting ? "Exporting…" : "Export journal"}
            </Button>
            <Button className="h-9 rounded-xl lg:hidden" onClick={() => setSheetOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" strokeWidth={2.2} />
              New invoice
            </Button>
          </>
        }
      />

      <div className="space-y-4">
        <Notice icon={Webhook} title="Settlement is Ping's call" tone="indigo">
          An invoice is marked paid when Ping's signed webhook says the session completed — the server re-reads the
          session before releasing anything. There is no manual "mark paid": an operator's word is not evidence of payment.
        </Notice>

        <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]">
          <div className="min-w-0">
            <Panel title="Invoices" description="Issued, open and paid — newest first.">
              <InvoicesTable invoices={invoices} loading={loading} />
            </Panel>
          </div>

          <div className="hidden lg:block">
            <div className="card-surface sticky top-6 p-4">
              <h2 className="text-[15px] font-semibold tracking-tight">New invoice</h2>
              <p className="mb-3 mt-0.5 text-xs text-muted-foreground">A checkout link, optionally wired to a payee.</p>
              <NewInvoiceForm payees={payable} onCreated={reload} />
            </div>
          </div>
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-[420px]">
          <SheetHeader className="border-b hairline px-5 py-4 text-left">
            <SheetTitle className="text-[17px] tracking-[-0.01em]">New invoice</SheetTitle>
            <SheetDescription className="text-[12px]">A checkout link, optionally wired to a payee.</SheetDescription>
          </SheetHeader>
          <div className="px-5 py-4">
            <NewInvoiceForm
              payees={payable}
              onCreated={() => {
                setSheetOpen(false);
                reload();
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}