import { useState } from "react";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format";
import { resolveFunding } from "@/lib/treasury";
import StatusChip from "@/components/common/StatusChip";
import Notice from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Eye, Lock } from "lucide-react";

function Row({ label, value, mono = true }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-right text-[11.5px] ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

export default function ResolveSheet({ item, open, onOpenChange, onResolved }) {
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const result = await resolveFunding(item);
      // "Still open" is a normal outcome, not a failure: the funds may not have
      // moved yet, and the request stays on the worklist.
      if (result.resolved) {
        toast.success(`${item.request_ref} → ${result.outcome}${result.duplicate ? " (already answered)" : ""}`);
      } else {
        toast.info(`${item.request_ref} is still open: ${result.reason ?? "unknown state"}`);
      }
      onOpenChange(false);
      onResolved?.();
    } catch (error) {
      toast.error(error?.message || "Could not re-read this request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[440px]">
        <SheetHeader className="border-b hairline px-5 py-4 text-left">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] font-medium">{item?.request_ref}</span>
            <StatusChip kind="worklist" value={item?.status} />
          </div>
          <SheetTitle className="mt-1 text-[17px] tracking-[-0.01em]">{item?.reason}</SheetTitle>
          <SheetDescription className="text-[12px]">{item?.detail}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 px-5 py-4">
          <Notice icon={Lock} title="Resolving is read-only" tone="indigo">
            This re-reads the true state of the operation and never re-submits it. No money moves when you resolve.
          </Notice>

          <div className="rounded-xl border hairline bg-secondary/40 px-3.5 py-2">
            <div className="mb-1 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
              <Eye className="h-3 w-3" strokeWidth={2} /> Read-back
            </div>
            <Row label="Operation" value={item?.operation_ref} />
            <Row label="Kind" value={item?.kind} />
            <Row label="Observed state" value={item?.observed_state} />
            <Row label="Opened" value={formatDateTime(item?.created_date)} />
            <Row label="Re-submitted" value="no" />
          </div>
        </div>

        <div className="sticky bottom-0 border-t hairline bg-white/90 px-5 py-4 backdrop-blur">
          <Button className="h-10 w-full rounded-xl text-[13px]" onClick={submit} disabled={busy || !item}>
            {busy ? "Re-reading…" : "Resolve (re-read only)"}
          </Button>
          <p className="mt-2 text-center text-[10.5px] text-muted-foreground">No re-submission happens from this action.</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}