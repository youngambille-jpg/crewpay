import type { ReactNode } from "react";

/**
 * A status token rendered as a pill. The mapping is deliberately explicit: an
 * unknown token gets the neutral treatment rather than being guessed at, so a
 * new backend status shows up as plain rather than silently looking healthy.
 */
const TONE: Record<string, string> = {
  // settled / good
  settled: "pill-ok",
  paid: "pill-ok",
  executed: "pill-ok",
  approved: "pill-ok",
  complete: "pill-ok",
  clear: "pill-ok",
  // in flight / informational
  open: "pill-info",
  quoted: "pill-info",
  pending: "pill-info",
  executing: "pill-info",
  partially_settled: "pill-info",
  submitted: "pill-info",
  signing: "pill-info",
  draft: "pill-neutral",
  // needs a human
  awaiting_approval: "pill-warn",
  needs_review: "pill-warn",
  incomplete: "pill-warn",
  review: "pill-warn",
  // terminal bad
  denied: "pill-bad",
  failed: "pill-bad",
  rejected: "pill-bad",
  blocked: "pill-bad",
  expired: "pill-bad",
  cancelled: "pill-bad",
  stale: "pill-bad",
  hit: "pill-bad",
};

export default function Status({ value, label }: { value: string; label?: string }) {
  const tone = TONE[value] ?? "pill-neutral";
  return <span className={`pill ${tone}`}>{label ?? value.replace(/_/g, " ")}</span>;
}

/** Compact icon-less stat tile. */
export function Tile({
  k,
  v,
  sub,
  accent,
}: {
  k: string;
  v: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`tile${accent ? " accent" : ""}`}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {sub ? <span className="sub">{sub}</span> : null}
    </div>
  );
}

/** A panel with a titled header and a right-aligned slot. */
export function Panel({
  title,
  count,
  right,
  children,
}: {
  title: string;
  count?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel-card">
      <div className="panel-head">
        <h2>{title}</h2>
        {count !== undefined ? <span className="count">{count}</span> : null}
        {right ? <span className="spacer">{right}</span> : null}
      </div>
      {children}
    </section>
  );
}
