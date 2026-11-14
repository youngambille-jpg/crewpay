import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Coins, Fuel, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Notice from "@/components/common/Notice";
import { formatBaseUnits, hasFunds, toBaseUnits } from "@/lib/format";
import { mintTestnet, readWallet } from "@/lib/treasury";
import { announceWalletChanged } from "@/hooks/useWallet";

const NEAR_DECIMALS = 24;
const USDT_DECIMALS = 6;

/**
 * The testnet faucet, from the console. Mints mock USDT.e to the treasury
 * wallet the API pays from — a real on-chain mint of the fakes token
 * (usdt.fakes.testnet), so the wallet can settle a pay run.
 *
 * Gas is the one thing this cannot do for you: only a human can send the first
 * testnet NEAR. The dialog says so plainly and disables Mint until the account
 * holds gas, rather than letting a click fail opaquely.
 */
export default function MintDialog({ open, onOpenChange, wallet, onMinted }) {
  const [amount, setAmount] = useState("100");
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState(wallet ?? null);

  useEffect(() => {
    if (!open) return;
    setLive(wallet ?? null);
    let alive = true;
    readWallet()
      .then((next) => {
        if (alive) setLive(next);
      })
      .catch(() => {
        /* keep the wallet we were handed; the mint will re-read anyway */
      });
    return () => {
      alive = false;
    };
  }, [open, wallet]);

  const gas = live?.gas_yocto ?? "0";
  const usdt = live?.usdt_base ?? "0";
  const hasGas = hasFunds(gas);

  async function copyAccount() {
    if (!live?.account) return;
    try {
      await navigator.clipboard.writeText(live.account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; the address stays visible and selectable */
    }
  }

  async function mint() {
    const amountBase = toBaseUnits(amount, USDT_DECIMALS);
    if (amountBase === "0") {
      toast.error("Enter an amount greater than zero");
      return;
    }
    setMinting(true);
    try {
      const result = await mintTestnet({ amountBase });
      const failed = (result.steps ?? []).find((s) => s.status === "failed");
      if (failed || !result.ready) {
        toast.error(failed?.detail || "Mint did not land");
      } else {
        const received = formatBaseUnits(result.balanceBase ?? "0", USDT_DECIMALS, { maxFractionDigits: 2 });
        toast.success(`Minted mock USDT.e — balance now ${received}`);
      }
      const next = await readWallet().catch(() => null);
      if (next) setLive(next);
      announceWalletChanged();
      onMinted?.();
    } catch (e) {
      toast.error(e?.message || "Could not mint");
    } finally {
      setMinting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b hairline px-5 py-4">
          <DialogTitle className="text-[15px]">Mint testnet USDT.e</DialogTitle>
          <DialogDescription className="text-xs">
            Top up the treasury with mock USDT for testnet payouts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4">
          <Notice icon={Sparkles} tone="indigo" title="Testnet only — mock money">
            This mints USDT.e on NEAR testnet ({`usdt.fakes.testnet`}). It is real on-chain, but the
            token is a test stand-in: it has no value and exists only so payouts can settle.
          </Notice>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border hairline bg-secondary/30 p-3">
              <div className="flex items-center gap-1.5">
                <Fuel className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.9} />
                <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Gas
                </span>
              </div>
              <div className="mt-2 font-mono text-[16px] font-semibold tabular">
                {formatBaseUnits(gas, NEAR_DECIMALS)} <span className="text-[10px] font-medium text-muted-foreground">NEAR</span>
              </div>
            </div>
            <div className="rounded-xl border hairline bg-secondary/30 p-3">
              <div className="flex items-center gap-1.5">
                <Coins className="h-3.5 w-3.5 text-emerald-600" strokeWidth={1.9} />
                <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Payroll
                </span>
              </div>
              <div className="mt-2 font-mono text-[16px] font-semibold tabular">
                {formatBaseUnits(usdt, USDT_DECIMALS, { maxFractionDigits: 2 })}{" "}
                <span className="text-[10px] font-medium text-muted-foreground">USDT.e</span>
              </div>
            </div>
          </div>

          {live?.account && (
            <div>
              <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                To account
              </span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-secondary/50 px-2.5 py-2 font-mono text-[11px]">
                  {live.account}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 rounded-lg px-2.5 text-[11px]"
                  onClick={copyAccount}
                >
                  {copied ? "copied" : "copy"}
                </Button>
              </div>
            </div>
          )}

          <div>
            <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              Amount to mint (USDT.e)
            </span>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-9 rounded-lg font-mono text-[12.5px]"
              placeholder="100"
            />
          </div>

          {!hasGas && (
            <Notice icon={TriangleAlert} tone="amber" title="This account has no gas yet">
              A mint costs a little testnet NEAR. Send some to the account above, then reopen this
              dialog — the mint needs gas before it can run.
            </Notice>
          )}

          <Button className="h-9 w-full rounded-lg text-[12px]" onClick={mint} disabled={minting || !hasGas}>
            {minting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                Minting…
              </>
            ) : (
              "Mint USDT.e"
            )}
          </Button>
          <p className="text-center text-[10px] leading-relaxed text-muted-foreground">
            Real on-chain mint of a testnet token. No value, no mainnet effect.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
