import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  Copy,
  Check,
  Fuel,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Notice from "@/components/common/Notice";
import { cn } from "@/lib/utils";
import { money, toCents, formatBaseUnits, hasFunds } from "@/lib/format";
import { readWallet, readFundingChains, quoteFunding } from "@/lib/treasury";

const NEAR_DECIMALS = 24;

/**
 * Fund the treasury, two ways:
 *
 *  - Direct transfer: send testnet NEAR (gas) or mock USDT.e to the account id.
 *    Real and actionable — the address is the wallet's own, and a transfer
 *    lands. The dialog re-reads the balance so the operator sees it move.
 *  - Cross-chain (NEAR Intents / 1Click): price a deposit from another chain.
 *    Simulation only. The price is a real 1Click quote, but Intents and 1Click
 *    have no testnet, so no deposit address is issued and nothing moves. The
 *    card says so rather than implying a transfer that cannot happen.
 */
export default function FundDialog({ open, onOpenChange, account, onFunded }) {
  const [copied, setCopied] = useState(null);
  const [gas, setGas] = useState("0");
  const [checking, setChecking] = useState(false);

  const [chains, setChains] = useState([]);
  const [chain, setChain] = useState("");
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    readFundingChains()
      .then((list) => {
        if (!live) return;
        setChains(list);
        setChain((current) => current || list[0]?.chain || "");
      })
      .catch(() => {
        /* the chooser simply stays empty; the direct tab still works */
      });
    return () => {
      live = false;
    };
  }, [open]);

  async function copy(value, key) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard can be blocked; the value stays visible and selectable */
    }
  }

  async function refreshBalance() {
    setChecking(true);
    try {
      const wallet = await readWallet();
      setGas(wallet.gas_yocto);
      onFunded?.();
      toast.success("Balance re-read from chain");
    } catch (e) {
      toast.error(e?.message || "Could not read the balance");
    } finally {
      setChecking(false);
    }
  }

  async function getQuote() {
    const usdCents = toCents(amount);
    if (usdCents <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    setQuoting(true);
    setConfirmed(false);
    try {
      setQuote(await quoteFunding({ chain, usdCents, recipient: account }));
    } catch (e) {
      setQuote(null);
      toast.error(e?.message || "Could not price that corridor");
    } finally {
      setQuoting(false);
    }
  }

  const gasDisplay = formatBaseUnits(gas, NEAR_DECIMALS);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b hairline px-5 py-4">
          <DialogTitle className="text-[15px]">Fund the treasury</DialogTitle>
          <DialogDescription className="text-xs">
            Top up the testnet wallet this deployment pays from.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="direct" className="px-5 py-4">
          <TabsList className="grid h-9 w-full grid-cols-2">
            <TabsTrigger value="direct" className="text-[12px]">
              <Send className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
              Direct transfer
            </TabsTrigger>
            <TabsTrigger value="cross" className="text-[12px]">
              <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
              Cross-chain
            </TabsTrigger>
          </TabsList>

          <TabsContent value="direct" className="mt-4 space-y-3">
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Send testnet NEAR for gas, or mock USDT.e for payroll, to this account. Both are real
              assets on NEAR testnet.
            </p>

            <div>
              <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Account id
              </span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-secondary/50 px-2.5 py-2 font-mono text-[11px]">
                  {account}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 rounded-lg"
                  onClick={() => copy(account, "account")}
                >
                  {copied === "account" ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border hairline bg-secondary/30 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Fuel className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.9} />
                <span className="text-[11.5px] text-muted-foreground">Current gas</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-semibold tabular">{gasDisplay} NEAR</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-md px-1.5"
                  onClick={refreshBalance}
                  disabled={checking}
                >
                  <RefreshCw className={cn("h-3 w-3", checking && "animate-spin")} strokeWidth={2} />
                </Button>
              </div>
            </div>

            {!hasFunds(gas) && (
              <Notice icon={TriangleAlert} tone="amber" title="This account has no gas yet">
                A payout cannot be signed until it holds testnet NEAR. Send a small amount from a
                testnet faucet, then refresh.
              </Notice>
            )}
          </TabsContent>

          <TabsContent value="cross" className="mt-4 space-y-3">
            <Notice icon={Sparkles} tone="indigo" title="Simulation — real price, no transfer">
              The quote is a live 1Click price. NEAR Intents and 1Click run on mainnet only, so no
              deposit address is issued and nothing moves.
            </Notice>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  From chain
                </span>
                <Select value={chain} onValueChange={setChain} disabled={!chains.length}>
                  <SelectTrigger className="h-9 rounded-lg text-[12.5px]">
                    <SelectValue placeholder="Chain" />
                  </SelectTrigger>
                  <SelectContent>
                    {chains.map((c) => (
                      <SelectItem key={c.chain} value={c.chain} className="text-[12.5px]">
                        {c.label} · {c.symbol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Amount (USD)
                </span>
                <Input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="h-9 rounded-lg font-mono text-[12.5px]"
                  placeholder="100.00"
                />
              </div>
            </div>

            <Button
              variant="outline"
              className="h-9 w-full rounded-lg text-[12px]"
              onClick={getQuote}
              disabled={quoting || !chain}
            >
              {quoting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                  Pricing…
                </>
              ) : (
                "Get quote"
              )}
            </Button>

            {quote && (
              <div className="rounded-xl border hairline bg-secondary/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    You send
                  </span>
                  <span className="font-mono text-[13px] font-semibold tabular">
                    {quote.amount_in_display || quote.amount_in} {quote.symbol}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>≈ {quote.amount_in_usd ? money(toCents(quote.amount_in_usd)) : "—"}</span>
                  <span className="font-mono">{quote.origin_label}</span>
                </div>

                <div className="my-2 flex items-center gap-2 text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <ArrowRightLeft className="h-3 w-3" strokeWidth={2} />
                  <span className="h-px flex-1 bg-border" />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    Treasury receives
                  </span>
                  <span className="font-mono text-[13px] font-semibold tabular">
                    {quote.amount_out_display || quote.amount_out} USDT
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>≈ {quote.amount_out_usd ? money(toCents(quote.amount_out_usd)) : "—"}</span>
                  <span className="font-mono">{quote.destination_label}</span>
                </div>

                <dl className="mt-3 space-y-1 border-t hairline pt-2 text-[11px]">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Rail fee</dt>
                    <dd className="font-mono tabular">{quote.fee} base units</dd>
                  </div>
                  {quote.time_estimate != null && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Estimated time</dt>
                      <dd className="font-mono tabular">~{quote.time_estimate}s</dd>
                    </div>
                  )}
                </dl>

                <Button
                  size="sm"
                  className="mt-3 h-9 w-full rounded-lg text-[12px]"
                  onClick={() => {
                    setConfirmed(true);
                    toast.success("Quote confirmed — simulation only, nothing was sent");
                  }}
                  disabled={confirmed}
                >
                  {confirmed ? (
                    <>
                      <Check className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
                      Confirmed (simulated)
                    </>
                  ) : (
                    "Confirm quote"
                  )}
                </Button>
                <p className="mt-1.5 text-center text-[10px] leading-relaxed text-muted-foreground">
                  Confirming records the price only. No deposit address is issued.
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
