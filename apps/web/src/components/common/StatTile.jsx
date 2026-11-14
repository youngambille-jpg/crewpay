import { cn } from "@/lib/utils";

const ICON_TONES = {
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  rose: "bg-rose-50 text-rose-600",
  slate: "bg-slate-100 text-slate-600",
};

export default function StatTile({ label, value, sub, icon: Icon, tone = "indigo" }) {
  return (
    <div className="card-surface group relative overflow-hidden p-4 transition-transform duration-300 hover:-translate-y-0.5 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        {Icon && (
          <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", ICON_TONES[tone])}>
            <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
          </span>
        )}
      </div>
      <div className="mt-3 font-mono text-[24px] font-semibold leading-none tracking-[-0.02em] tabular sm:text-[26px]">
        {value}
      </div>
      {sub && <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{sub}</div>}
    </div>
  );
}