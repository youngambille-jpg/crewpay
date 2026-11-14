import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV } from "@/components/shell/nav";
import useWallet from "@/hooks/useWallet";
import MintDialog from "@/components/funding/MintDialog";

export function BrandMark({ className }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-indigo-500 to-violet-600 font-mono text-[15px] font-semibold text-white shadow-[0_6px_16px_-8px_rgba(79,70,229,0.9)]",
        className,
      )}
    >
      C
    </span>
  );
}

function NavItem({ item, active, onNavigate }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-all duration-200",
        active
          ? "bg-[#121826] text-white shadow-[0_8px_20px_-14px_rgba(16,24,40,0.9)]"
          : "text-muted-foreground hover:bg-black/[0.035] hover:text-foreground",
      )}
    >
      <Icon className={cn("h-4 w-4", active ? "text-indigo-300" : "text-muted-foreground/80")} strokeWidth={1.8} />
      {item.label}
    </Link>
  );
}

export default function Sidebar({ pathname, onNavigate, className }) {
  const isActive = (item) =>
    item.exact ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
  const { wallet, reload } = useWallet();
  const [minting, setMinting] = useState(false);

  return (
    <div className={cn("flex h-full w-[248px] shrink-0 flex-col border-r hairline bg-white/80 px-3 py-4", className)}>
      <Link to="/app" onClick={onNavigate} className="mb-6 flex items-center gap-2.5 rounded-xl px-2 py-1">
        <BrandMark />
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-[-0.01em]">CrewPay</span>
          <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Operator console
          </span>
        </span>
      </Link>

      <nav className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <NavItem key={item.to} item={item} active={isActive(item)} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="mt-auto pt-6">
        <button
          type="button"
          onClick={() => setMinting(true)}
          className="mb-2 flex w-full items-center gap-2.5 rounded-xl border hairline bg-white px-3 py-2 text-left text-[12.5px] font-medium transition-colors hover:bg-secondary/60"
        >
          <Coins className="h-4 w-4 text-emerald-600" strokeWidth={1.8} />
          <span className="flex-1">Mint testnet USDT</span>
        </button>
        <div className="rounded-xl border hairline bg-white p-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#121826] font-mono text-[11px] font-medium text-white">
              OP
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[12px] font-medium">Operator</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">org_1</span>
            </span>
          </div>
        </div>
      </div>

      <MintDialog open={minting} onOpenChange={setMinting} wallet={wallet} onMinted={reload} />
    </div>
  );
}
