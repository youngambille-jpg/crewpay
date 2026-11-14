import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import RunLineRow from "@/components/payruns/RunLineRow";
import { createPayRun } from "@/lib/treasury";
import { money, toCents } from "@/lib/format";

const SOURCES = ["api", "csv", "schedule", "invoice"];

/**
 * Where the payroll is funded from. Sent as `origin`; the server decides the
 * corridor per line. This deployment settles mock assets on NEAR testnet, so
 * near:usdt is the default — the other entries are listed because the API
 * accepts them, not because this deployment can fund them yet.
 */
const ORIGINS = [
  { value: "near:usdt", label: "near · USDT" },
  { value: "near:usdc", label: "near · USDC" },
  { value: "base:usdc", label: "base · USDC" },
];

const newRow = () => ({ key: `${Date.now()}-${Math.random()}`, payee_id: "", amount: "" });

export default function NewRunForm({ payees, onCreated }) {
  const [period, setPeriod] = useState(() =>
    new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
  );
  const [source, setSource] = useState("api");
  const [origin, setOrigin] = useState("near:usdt");
  const [rows, setRows] = useState([newRow()]);
  const [busy, setBusy] = useState(false);

  const total = rows.reduce((sum, row) => sum + toCents(row.amount), 0);

  function update(key, patch) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function submit(event) {
    event.preventDefault();
    const lines = rows
      .filter((row) => row.payee_id && toCents(row.amount) > 0)
      .map((row) => ({
        payee: payees.find((item) => item.id === row.payee_id),
        amount_cents: toCents(row.amount),
      }));

    if (!lines.length) {
      toast.error("Add at least one line with a payee and an amount");
      return;
    }

    setBusy(true);
    try {
      const [chain, asset] = origin.split(":");
      const run = await createPayRun({ period, source, origin: { chain, asset }, lines });
      toast.success(`Run ${run.run_ref} decided — ${run.settled_count} settled, ${run.held_count} held`);
      setRows([newRow()]);
      onCreated?.(run);
    } catch (error) {
      toast.error(error?.message || "Could not create the pay run");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground" htmlFor="run-period">
          Period
        </label>
        <Input
          id="run-period"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          className="h-9 rounded-lg text-[12.5px]"
        />
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Source</label>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-9 rounded-lg text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((option) => (
              <SelectItem key={option} value={option} className="text-[12.5px] capitalize">
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Funding origin</label>
        <Select value={origin} onValueChange={setOrigin}>
          <SelectTrigger className="h-9 rounded-lg text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORIGINS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-[12.5px]">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">Lines</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {rows.length} {rows.length === 1 ? "line" : "lines"}
          </span>
        </div>
        <div className="space-y-2">
          {rows.map((row) => (
            <RunLineRow
              key={row.key}
              row={row}
              payees={payees}
              onChange={update}
              canRemove={rows.length > 1}
              onRemove={(key) => setRows((current) => current.filter((item) => item.key !== key))}
            />
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 h-8 w-full rounded-lg border-dashed text-[11.5px]"
          onClick={() => setRows((current) => [...current, newRow()])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={2} />
          Add line
        </Button>
      </div>

      <div className="flex items-center justify-between border-t hairline pt-3">
        <span className="text-[11px] text-muted-foreground">Batch value</span>
        <span className="font-mono text-[13px] font-semibold tabular">{money(total)}</span>
      </div>

      <Button type="submit" className="h-10 w-full rounded-xl text-[13px]" disabled={busy}>
        {busy ? "Deciding batch…" : "Create pay run"}
      </Button>
      <p className="text-center text-[10.5px] leading-relaxed text-muted-foreground">
        Each line is decided by the active policy — settles, holds, or denies on its own.
      </p>
    </form>
  );
}