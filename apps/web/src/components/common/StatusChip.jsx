import { cn } from "@/lib/utils";
import { dotClass, statusMeta, toneClass } from "@/lib/status";

export default function StatusChip({ kind, value, label, className }) {
  const meta = statusMeta(kind, value);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        toneClass(meta.tone),
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(meta.tone))} />
      {label ?? meta.label}
    </span>
  );
}