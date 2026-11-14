import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
export default function RunLineRow({ row, payees, onChange, onRemove, canRemove }) {
  return (
    <div className="rounded-xl border hairline bg-white p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <Select value={row.payee_id} onValueChange={(value) => onChange(row.key, { payee_id: value })}>
            <SelectTrigger className="h-9 rounded-lg text-[12.5px]">
              <SelectValue placeholder="Select payee" />
            </SelectTrigger>
            <SelectContent>
              {payees.map((option) => (
                <SelectItem key={option.id} value={option.id} className="text-[12.5px]">
                  {option.name} · {option.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-muted-foreground">
              $
            </span>
            <Input
              value={row.amount}
              onChange={(event) => onChange(row.key, { amount: event.target.value })}
              placeholder="0.00"
              inputMode="decimal"
              className="h-9 rounded-lg pl-6 font-mono text-[12.5px] tabular"
            />
          </div>
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={() => onRemove(row.key)}
            aria-label="Remove line"
            className="mt-1 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-rose-600"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}