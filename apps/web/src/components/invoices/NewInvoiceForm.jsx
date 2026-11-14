import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createInvoice } from "@/lib/treasury";
import { money, toCents } from "@/lib/format";

const emptyLine = () => ({ description: "", quantity: "1", unitAmount: "" });

export default function NewInvoiceForm({ payees, onCreated }) {
  const [customer, setCustomer] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [payeeId, setPayeeId] = useState("none");
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);

  const lineTotal = lines.reduce((sum, line) => sum + toCents(line.unitAmount) * (Number(line.quantity) || 0), 0);
  const itemised = lines.length > 0;
  const total = itemised ? lineTotal : toCents(amount);

  function updateLine(index, patch) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function submit(event) {
    event.preventDefault();
    if (!customer.trim() || total <= 0) {
      toast.error("Customer and an amount above zero are required");
      return;
    }
    if (itemised) {
      const bad = lines.find((line) => !line.description.trim() || !(Number(line.quantity) > 0));
      if (bad) {
        toast.error("Every line needs a description and a quantity");
        return;
      }
    }
    setBusy(true);
    try {
      const payee = payees.find((item) => item.id === payeeId);
      const invoice = await createInvoice({
        customer: customer.trim(),
        amount_cents: total,
        ...(dueDate ? { dueDate } : {}),
        ...(itemised
          ? {
              lineItems: lines.map((line) => ({
                description: line.description.trim(),
                quantity: Number(line.quantity) || 1,
                unitAmount: toCents(line.unitAmount),
              })),
            }
          : {}),
        payee,
      });
      toast.success(`${invoice.invoice_ref} issued`);
      setCustomer("");
      setAmount("");
      setDueDate("");
      setPayeeId("none");
      setLines([]);
      onCreated?.(invoice);
    } catch (error) {
      toast.error(error?.message || "Could not issue the invoice");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground" htmlFor="invoice-customer">
          Customer
        </label>
        <Input
          id="invoice-customer"
          value={customer}
          onChange={(event) => setCustomer(event.target.value)}
          placeholder="e.g. Halcyon Labs"
          className="h-9 rounded-lg text-[12.5px]"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground" htmlFor="invoice-amount">
            Amount
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-muted-foreground">
              $
            </span>
            <Input
              id="invoice-amount"
              value={itemised ? (lineTotal / 100).toFixed(2) : amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              readOnly={itemised}
              className="h-9 rounded-lg pl-6 font-mono text-[12.5px] tabular"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground" htmlFor="invoice-due">
            Due date
          </label>
          <Input
            id="invoice-due"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            className="h-9 rounded-lg text-[12.5px]"
          />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">Line items (optional)</span>
          <button
            type="button"
            onClick={() => setLines((current) => [...current, emptyLine()])}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3 w-3" strokeWidth={2.4} /> Add line
          </button>
        </div>
        {itemised ? (
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={line.description}
                  onChange={(event) => updateLine(index, { description: event.target.value })}
                  placeholder="Description"
                  className="h-8 flex-1 rounded-lg text-[12px]"
                />
                <Input
                  value={line.quantity}
                  onChange={(event) => updateLine(index, { quantity: event.target.value })}
                  inputMode="numeric"
                  className="h-8 w-12 rounded-lg text-center font-mono text-[12px]"
                />
                <Input
                  value={line.unitAmount}
                  onChange={(event) => updateLine(index, { unitAmount: event.target.value })}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="h-8 w-20 rounded-lg font-mono text-[12px] tabular"
                />
                <button
                  type="button"
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-rose-600"
                  aria-label="Remove line"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            ))}
            <div className="flex justify-end pr-7 font-mono text-[11.5px] text-muted-foreground">
              Total {money(lineTotal)}
            </div>
          </div>
        ) : (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            Add lines to itemise the invoice. The total must equal the sum of its lines.
          </p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Auto-payee (optional)</label>
        <Select value={payeeId} onValueChange={setPayeeId}>
          <SelectTrigger className="h-9 rounded-lg text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none" className="text-[12.5px]">
              No auto-payee
            </SelectItem>
            {payees.map((payee) => (
              <SelectItem key={payee.id} value={payee.id} className="text-[12.5px]">
                {payee.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
          When paid, an invoice with an auto-payee opens a pay run for that payee.
        </p>
      </div>

      <Button type="submit" className="h-10 w-full rounded-xl text-[13px]" disabled={busy}>
        {busy ? "Issuing…" : "Issue invoice"}
      </Button>
    </form>
  );
}
