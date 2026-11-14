import { ArrowLeftRight, BookOpen, Inbox, LayoutGrid, Receipt, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";

export const NAV = [
  { to: "/app", label: "Overview", icon: LayoutGrid, exact: true },
  { to: "/app/pay-runs", label: "Pay runs", icon: ArrowLeftRight },
  { to: "/app/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/app/worklist", label: "Worklist", icon: Inbox },
  { to: "/app/payees", label: "Payees", icon: Users },
  { to: "/app/invoices", label: "Invoices", icon: Receipt },
  { to: "/app/policy", label: "Policy", icon: SlidersHorizontal },
  { to: "/app/ledger", label: "Ledger", icon: BookOpen },
];

export function navTitle(pathname) {
  const match = [...NAV].reverse().find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  return match?.label ?? "Console";
}