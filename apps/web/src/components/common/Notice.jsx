import { cn } from "@/lib/utils";

const TONE = {
  indigo: "border-indigo-100 bg-indigo-50/70 text-indigo-900",
  amber: "border-amber-100 bg-amber-50/70 text-amber-900",
  slate: "border-border bg-secondary/60 text-foreground",
};

export default function Notice({ icon: Icon, title, children, tone = "indigo" }) {
  return (
    <div className={cn("flex gap-2.5 rounded-xl border px-3.5 py-3", TONE[tone])}>
      {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" strokeWidth={2} />}
      <div className="min-w-0">
        {title && <p className="text-[12px] font-semibold leading-snug">{title}</p>}
        {children && <p className="mt-0.5 text-[11.5px] leading-relaxed opacity-80">{children}</p>}
      </div>
    </div>
  );
}