import { cn } from "@/lib/utils";

export default function Panel({ title, description, action, children, className, bodyClassName }) {
  return (
    <section className={cn("card-surface flex flex-col overflow-hidden", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b hairline px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
            {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={cn("flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}