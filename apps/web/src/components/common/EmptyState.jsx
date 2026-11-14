export default function EmptyState({ icon: Icon, title, note, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon && (
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
          <Icon className="h-4 w-4" strokeWidth={1.7} />
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {note && <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{note}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}