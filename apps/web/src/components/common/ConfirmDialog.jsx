import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  tone = "default",
  busy,
  onConfirm,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-[17px] tracking-[-0.01em]">{title}</DialogTitle>
          {description && (
            <DialogDescription className="text-[13px] leading-relaxed">{description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter className="mt-3 gap-2 sm:justify-end">
          <Button variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "destructive" : "default"}
            className="rounded-xl"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}