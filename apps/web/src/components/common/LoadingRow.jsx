export default function LoadingRow({ label = "Reading ledger…" }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-6 text-[11.5px] text-muted-foreground sm:px-5">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
      {label}
    </div>
  );
}