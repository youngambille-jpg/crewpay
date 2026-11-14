import { formatDate, money } from "@/lib/format";
import StatusChip from "@/components/common/StatusChip";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import { ExternalLink, Receipt } from "lucide-react";

/**
 * Read-only by design: an invoice is marked paid only when Ping's signed
 * webhook says the session completed, so there is no row action here. The
 * checkout link is the operator's lever — everything else is Ping's call.
 */
export default function InvoicesTable({ invoices, loading }) {
  if (loading) return <LoadingRow label="Loading invoices…" />;
  if (!invoices.length) return <EmptyState icon={Receipt} title="No invoices yet" note="Issue one to collect from a customer." />;

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b hairline bg-secondary/40">
              {["Invoice", "Customer", "Amount", "Status", "Due", "Created", "Checkout", "Tx", ""].map((head, index) => (
                <th
                  key={head || index}
                  className="whitespace-nowrap px-3 py-2.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground first:pl-5 last:pr-5"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="transition-colors hover:bg-secondary/40">
                <td className="px-3 py-3 pl-5 font-mono text-[11.5px] font-medium">{invoice.invoice_ref}</td>
                <td className="max-w-[160px] px-3 py-3">
                  <div className="truncate text-[12.5px]">{invoice.customer}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-mono text-[12px] font-medium tabular">
                  {money(invoice.amount_cents)}
                </td>
                <td className="px-3 py-3">
                  <StatusChip kind="invoice" value={invoice.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-[11.5px] text-muted-foreground">
                  {invoice.due_date ? formatDate(invoice.due_date) : "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-[11.5px] text-muted-foreground">
                  {formatDate(invoice.created_date)}
                </td>
                <td className="px-3 py-3">
                  {invoice.checkout_url ? (
                    <a
                      href={invoice.checkout_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[10.5px] text-indigo-600 hover:text-indigo-700"
                    >
                      ping <ExternalLink className="h-3 w-3" strokeWidth={2} />
                    </a>
                  ) : (
                    <span className="font-mono text-[10.5px] text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  {invoice.tx_hashes?.length > 0 ? (
                    <span
                      title={invoice.tx_hashes.join("\n")}
                      className="inline-flex items-center gap-1 font-mono text-[10.5px] text-emerald-600"
                    >
                      {invoice.tx_hashes[0].slice(0, 10)}…
                    </span>
                  ) : (
                    <span className="font-mono text-[10.5px] text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-3 pr-5">
                  <a
                    href={invoice.pay_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10.5px] text-indigo-600 hover:text-indigo-700"
                  >
                    pay page <ExternalLink className="h-3 w-3" strokeWidth={2} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border/60 md:hidden">
        {invoices.map((invoice) => (
          <li key={invoice.id} className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-muted-foreground">{invoice.invoice_ref}</div>
                <div className="mt-0.5 truncate text-[13.5px] font-medium">{invoice.customer}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[13px] font-medium tabular">{money(invoice.amount_cents)}</div>
                <div className="mt-1">
                  <StatusChip kind="invoice" value={invoice.status} />
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <a
                  href={invoice.pay_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[10.5px] text-indigo-600"
                >
                  pay page <ExternalLink className="h-3 w-3" strokeWidth={2} />
                </a>
                {invoice.checkout_url ? (
                  <a
                    href={invoice.checkout_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground"
                  >
                    ping
                  </a>
                ) : null}
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                {invoice.due_date
                  ? `due ${formatDate(invoice.due_date)}`
                  : invoice.status === "paid"
                    ? formatDate(invoice.paid_date)
                    : formatDate(invoice.created_date)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}