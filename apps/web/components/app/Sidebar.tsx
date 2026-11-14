"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "../Icons";

const GROUPS: { label: string; links: { href: string; label: string }[] }[] = [
  {
    label: "Operate",
    links: [
      { href: "/app", label: "Overview" },
      { href: "/app/pay-runs", label: "Pay runs" },
      { href: "/app/approvals", label: "Approvals" },
      { href: "/app/worklist", label: "Worklist" },
    ],
  },
  {
    label: "Money",
    links: [
      { href: "/app/payees", label: "Payees" },
      { href: "/app/invoices", label: "Invoices" },
      { href: "/app/agents", label: "Agent tasks" },
    ],
  },
  {
    label: "Control",
    links: [
      { href: "/app/connect", label: "Connect" },
      { href: "/app/policy", label: "Policy" },
      { href: "/app/ledger", label: "Ledger" },
    ],
  },
];

export default function Sidebar({ counts }: { counts: Partial<Record<string, number>> }) {
  const pathname = usePathname();

  return (
    <aside className="side">
      <Link href="/" className="side-brand">
        <Logo size={24} />
        CrewPay
      </Link>

      <div className="side-org">
        <span className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
          A
        </span>
        <span>
          <b>Acme Inc</b> · org_1
        </span>
      </div>

      {GROUPS.map((g) => (
        <div className="side-group" key={g.label}>
          <span className="side-label">{g.label}</span>
          {g.links.map((l) => {
            const active = pathname === l.href;
            const badge = counts[l.href];
            return (
              <Link key={l.href} href={l.href} className={`side-link${active ? " on" : ""}`}>
                {l.label}
                {badge ? <span className="dot" /> : null}
              </Link>
            );
          })}
        </div>
      ))}

      <div className="side-foot">
        Demo org on the fake rail. No network, no credentials, no real money.
      </div>
    </aside>
  );
}
