export default function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-7 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</div>
        )}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[32px]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground sm:text-sm">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}