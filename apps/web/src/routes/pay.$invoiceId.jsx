import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Copy, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publicGet, publicPost } from "@/api/server-calls";
import { money, formatDate } from "@/lib/format";
import StatusChip from "@/components/common/StatusChip";
import { BrandMark } from "@/components/shell/Sidebar";

/**
 * The customer-facing pay page. Public by design: the invoice id in the URL is
 * the capability, so this route lives outside the `_authed` layout and talks to
 * the unauthenticated `/v1/pay/*` API.
 *
 * Payment is real up to the transfer: choosing a chain asks the server for a
 * live 1Click deposit address (a real quote into our NEAR settlement asset), and
 * the customer sends the origin asset to it. Only that final send is the human's
 * to make; everything else — pricing, the address, settlement — is live.
 */
export const Route = createFileRoute("/pay/$invoiceId")({
  component: PayPage,
});

function PayPage() {
  const { invoiceId } = Route.useParams();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState(null);
  const [chain, setChain] = useState(null);
  const [session, setSession] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [rail, setRail] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await publicGet(`/v1/pay/${encodeURIComponent(invoiceId)}`);
      setInvoice(data);
      if (data.payment?.originChain) setChain((c) => c ?? data.payment.originChain);
    } catch (err) {
      setError(err?.message || "This invoice could not be found.");
    }
  }, [invoiceId]);

  useEffect(() => {
    load();
  }, [load]);

  const paid = invoice?.status === "paid";

  // Once an address exists, poll the server, which re-reads 1Click and applies
  // the settlement to the invoice exactly once.
  useEffect(() => {
    if (!session?.depositAddress || paid) return;
    let stop = false;
    const tick = async () => {
      try {
        const status = await publicGet(`/v1/pay/${encodeURIComponent(invoiceId)}/status`);
        if (stop) return;
        setRail(status);
        if (status.settled) await load();
      } catch {
        /* transient; try again on the next tick */
      }
    };
    const id = setInterval(tick, 8000);
    tick();
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [session?.depositAddress, paid, invoiceId, load]);

  async function choose(chainId) {
    setChain(chainId);
    setQuoting(true);
    setError(null);
    try {
      const quote = await publicPost(`/v1/pay/${encodeURIComponent(invoiceId)}/quote`, { originChain: chainId });
      setSession(quote);
    } catch (err) {
      setError(err?.message || "Could not open a payment session for that chain.");
    } finally {
      setQuoting(false);
    }
  }

  const due = useMemo(() => {
    if (!invoice?.dueDate) return null;
    const overdue = !paid && Date.parse(invoice.dueDate) < Date.now();
    return { text: formatDate(invoice.dueDate), overdue };
  }, [invoice?.dueDate, paid]);

  return (
    <div className="relative flex min-h-screen justify-center overflow-hidden bg-background px-5 py-14">
      <div aria-hidden className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-indigo-500/10 blur-[100px]" />
      <div className="relative w-full max-w-[520px]">
        <div className="mb-5 flex items-center gap-2.5">
          <BrandMark className="h-9 w-9 rounded-xl text-[16px]" />
          <span className="text-[15px] font-semibold tracking-[-0.02em]">CrewPay</span>
        </div>

        {error && !invoice ? (
          <div className="card-surface p-7 text-center">
            <p className="text-[15px] font-medium">Invoice not found</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{error}</p>
          </div>
        ) : !invoice ? (
          <div className="card-surface flex items-center justify-center gap-2 p-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading invoice…
          </div>
        ) : (
          <div className="card-surface p-6 sm:p-7">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
                  Invoice {invoice.id}
                </div>
                <div className="mt-1.5 text-[30px] font-semibold tracking-[-0.03em] tabular">{money(invoice.amount)}</div>
                {due ? (
                  <div className={`mt-1 text-[12px] ${due.overdue ? "text-rose-600" : "text-muted-foreground"}`}>
                    {due.overdue ? "Was due" : "Due"} {due.text}
                  </div>
                ) : null}
              </div>
              <StatusChip kind="invoice" value={invoice.status} />
            </div>

            {invoice.lineItems?.length > 0 ? (
              <div className="mt-5 divide-y divide-border/60 rounded-xl border hairline">
                {invoice.lineItems.map((line, index) => (
                  <div key={index} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[12.5px]">
                    <span className="min-w-0 truncate">
                      {line.description}
                      {line.quantity > 1 ? <span className="text-muted-foreground"> × {line.quantity}</span> : null}
                    </span>
                    <span className="font-mono tabular">{money(line.amount)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {paid ? (
              <div className="mt-6 rounded-xl bg-emerald-500/10 p-4 ring-1 ring-inset ring-emerald-500/20">
                <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" /> Paid
                </div>
                <p className="mt-1 text-[12px] text-emerald-700/80">
                  Settled{invoice.paidAt ? ` on ${formatDate(invoice.paidAt)}` : ""}. No further action is needed.
                </p>
                {invoice.txHashes?.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {invoice.txHashes.map((hash) => (
                      <div key={hash} className="truncate font-mono text-[10.5px] text-emerald-700/80">
                        {hash}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <div className="mt-6">
                  <div className="mb-2 text-[11px] font-medium text-muted-foreground">Pay from</div>
                  <div className="flex flex-wrap gap-2">
                    {(invoice.supportedChains ?? []).map((option) => (
                      <button
                        key={option.chain}
                        type="button"
                        onClick={() => choose(option.chain)}
                        disabled={quoting}
                        className={`rounded-xl border px-3.5 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-50 ${
                          chain === option.chain
                            ? "border-indigo-500 bg-indigo-500/10 text-indigo-700"
                            : "border-input hover:bg-secondary"
                        }`}
                      >
                        {option.label} · {option.symbol}
                      </button>
                    ))}
                  </div>
                </div>

                {quoting ? (
                  <div className="mt-5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Pricing the corridor…
                  </div>
                ) : null}

                {session ? (
                  <DepositInstructions session={session} rail={rail} />
                ) : (
                  <p className="mt-5 text-[12px] leading-relaxed text-muted-foreground">
                    Pick the chain you hold funds on. We price it live through NEAR Intents and give you an address to
                    send to — you are not moved off the chain you already use.
                  </p>
                )}
              </>
            )}

            {error && invoice ? <p className="mt-4 text-[12px] text-rose-600">{error}</p> : null}
          </div>
        )}

        <p className="mt-4 text-center text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
          Payments settle on NEAR through NEAR Intents
        </p>
      </div>
    </div>
  );
}

function DepositInstructions({ session, rail }) {
  const [copied, setCopied] = useState(false);
  const amount = session.amountInFormatted ?? session.amountIn;
  const originLabel = (session.originChain ?? "").toUpperCase();

  async function copy() {
    try {
      await navigator.clipboard.writeText(session.depositAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the address is visible to select manually */
    }
  }

  const state = rail?.settled
    ? { label: "Settled", tone: "emerald" }
    : rail?.rail === "PENDING_DEPOSIT" || !rail
      ? { label: "Waiting for your transfer", tone: "amber" }
      : { label: "Processing", tone: "indigo" };

  return (
    <div className="mt-5 rounded-xl border hairline p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium">
          Send {amount} {originLabel}
        </span>
        <span className={`font-mono text-[10px] uppercase tracking-[0.1em] ${state.tone === "amber" ? "text-amber-600" : state.tone === "emerald" ? "text-emerald-600" : "text-indigo-600"}`}>
          {state.label}
        </span>
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">Deposit address</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-secondary px-2.5 py-2 font-mono text-[12px]">
            {session.depositAddress}
          </code>
          <Button type="button" variant="outline" size="sm" className="h-9 rounded-lg" onClick={copy}>
            {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      {session.depositMemo ? (
        <div className="mt-3">
          <div className="mb-1 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">Required memo</div>
          <code className="block truncate rounded-lg bg-secondary px-2.5 py-2 font-mono text-[12px]">
            {session.depositMemo}
          </code>
        </div>
      ) : null}
      <p className="mt-3 flex items-center gap-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
        <RefreshCw className="h-3 w-3" />
        We receive {session.amountOutFormatted ?? session.amountOut} on NEAR and settle this invoice automatically. This
        address is valid until {new Date(session.deadline).toLocaleString()}.
      </p>
    </div>
  );
}
