import { useState } from "react";
import { Copy, Check, Fuel, Coins, Wallet, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBaseUnits, hasFunds } from "@/lib/format";
import FundDialog from "@/components/funding/FundDialog";

const NEAR_DECIMALS = 24;
const USDT_DECIMALS = 6;

/** One balance line: a label, a big figure, and the base-unit truth beneath. */
function Balance({ icon: Icon, label, amount, symbol, base, tone }) {
  return (
    <div className="rounded-xl border hairline bg-secondary/30 p-3">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("h-3.5 w-3.5", tone)} strokeWidth={1.9} />
        <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-mono text-[20px] font-semibold leading-none tabular">{amount}</span>
        <span className="text-[11px] font-medium text-muted-foreground">{symbol}</span>
      </div>
      <div className="mt-1 truncate font-mono text-[9.5px] text-muted-foreground/70" title={base}>
        {base} base units
      </div>
    </div>
  );
}

/**
 * The testnet treasury: the real account the API pays from, and its real
 * on-chain balances. Both figures are read from chain, never assumed. The
 * readiness line states the one thing that actually blocks a payout — gas —
 * rather than letting an empty wallet look merely "connected".
 */
export default function WalletCard({ wallet, loading, error, onRefresh }) {
  const [copied, setCopied] = useState(false);
  const [funding, setFunding] = useState(false);

  const gas = wallet?.gas_yocto ?? "0";
  const usdt = wallet?.usdt_base ?? "0";
  const hasGas = hasFunds(gas);
  const hasUsdt = hasFunds(usdt);
  const ready = hasGas && hasUsdt;

  async function copyAccount() {
    if (!wallet?.account) return;
    try {
      await navigator.clipboard.writeText(wallet.account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; the address is visible and selectable anyway */
    }
  }

  return (
    <section className="card-surface overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b hairline px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
            <Wallet className="h-4 w-4 text-indigo-600" strokeWidth={1.9} />
            Treasury wallet
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            The testnet account this deployment pays from, read live from chain.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 rounded-lg text-[11.5px]"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw className={cn("mr-1 h-3 w-3", loading && "animate-spin")} strokeWidth={2} />
          Refresh
        </Button>
      </header>

      <div className="p-4 sm:p-5">
        {loading && !wallet ? (
          <p className="text-[12.5px] text-muted-foreground">Reading the wallet…</p>
        ) : error ? (
          <p className="text-[12.5px] text-rose-600">{error.message}</p>
        ) : !wallet?.connected ? (
          <p className="text-[12.5px] text-muted-foreground">
            No testnet wallet is held. The API registers one at boot; check the server log.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Account
              </span>
              <button
                type="button"
                onClick={copyAccount}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                title="Copy account id"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <div className="mt-1 break-all rounded-lg bg-secondary/50 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
              {wallet.account}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Balance
                icon={Fuel}
                label="Gas"
                amount={formatBaseUnits(gas, NEAR_DECIMALS)}
                symbol="NEAR"
                base={gas}
                tone={hasGas ? "text-emerald-600" : "text-rose-500"}
              />
              <Balance
                icon={Coins}
                label="Payroll"
                amount={formatBaseUnits(usdt, USDT_DECIMALS, { maxFractionDigits: 2 })}
                symbol="USDT.e"
                base={usdt}
                tone={hasUsdt ? "text-emerald-600" : "text-rose-500"}
              />
            </div>

            <div className="mt-3 flex items-start justify-between gap-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {ready
                  ? "Funded — this wallet can broadcast a payout."
                  : !hasGas
                    ? "No gas: a payout cannot be signed until this account holds testnet NEAR."
                    : "No payroll funds: mint or receive mock USDT.e before a run can settle."}
              </p>
              <Button
                size="sm"
                className="h-8 shrink-0 rounded-lg text-[11.5px]"
                onClick={() => setFunding(true)}
              >
                Fund
              </Button>
            </div>
          </>
        )}
      </div>

      {wallet?.account && (
        <FundDialog
          open={funding}
          onOpenChange={setFunding}
          account={wallet.account}
          onFunded={onRefresh}
        />
      )}
    </section>
  );
}
