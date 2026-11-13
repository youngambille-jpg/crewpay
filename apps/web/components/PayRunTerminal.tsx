"use client";

import { useEffect, useRef, useState } from "react";

type Status = "settled" | "approval" | "review" | "denied";

type Line = {
  tag: string;
  status: Status;
  payee: string;
  detail: string;
};

/* These rows mirror what `npm run demo` actually prints: one contractor
   settles with a deposit proof, one vendor over threshold opens an approval,
   one funding lands in an unknown state and stops, one agent payee is denied
   by the per-kind cap. Nothing here is invented for the page. */
const LINES: Line[] = [
  {
    tag: "SETTLED",
    status: "settled",
    payee: "contractor · 0x7a…31f2",
    detail: "1,500.00 USDC · base → near",
  },
  {
    tag: "APPROVAL",
    status: "approval",
    payee: "vendor · invoices@acme.co",
    detail: "12,400.00 USDC · over threshold",
  },
  {
    tag: "NEEDS REVIEW",
    status: "review",
    payee: "contractor · 0x9c…04ab",
    detail: "funding unknown — stopped, not retried",
  },
  {
    tag: "DENIED",
    status: "denied",
    payee: "agent · research-bot",
    detail: "per-kind cap exceeded · 0 moved",
  },
];

export default function PayRunTerminal() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      setShown(LINES.length);
      return;
    }

    let timers: ReturnType<typeof setTimeout>[] = [];

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.disconnect();
          LINES.forEach((_, i) => {
            timers.push(setTimeout(() => setShown(i + 1), 380 + i * 520));
          });
        }
      },
      { threshold: 0.35 },
    );

    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="terminal" ref={ref} aria-label="Example pay run output">
      <div className="terminal-bar">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span style={{ marginLeft: 8 }}>crewpay — pay run · policy v7 · 4 operations</span>
      </div>

      <div className="terminal-body">
        {LINES.map((line, i) => (
          <div
            className="row"
            key={line.tag}
            style={{
              opacity: i < shown ? 1 : 0,
              transform: i < shown ? "none" : "translateY(6px)",
              transition: "opacity .5s ease, transform .5s ease",
            }}
          >
            <span className={`tag ${line.status}`}>{line.tag}</span>
            <span>
              {line.payee}
              <span className="dim"> — {line.detail}</span>
            </span>
            <span className="dim">{i < shown ? "✓" : ""}</span>
          </div>
        ))}

        <div
          className="row"
          style={{
            opacity: shown >= LINES.length ? 1 : 0,
            transition: "opacity .6s ease .2s",
          }}
        >
          <span className="dim">LEDGER</span>
          <span className="dim">
            balanced journal entry written for every settled line
          </span>
          <span className="dim">Σ = 0</span>
        </div>
      </div>
    </div>
  );
}
