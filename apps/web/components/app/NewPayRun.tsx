"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type Payee, usd } from "@/lib/api";

/**
 * Compose and submit a pay run. Amounts are entered in dollars and sent as
 * integer cents — the API never sees a float.
 */
export default function NewPayRun({ payees }: { payees: Payee[] }) {
  const router = useRouter();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const lines = Object.entries(amounts)
    .map(([payeeId, v]) => ({ payeeId, usdCents: Math.round(Number(v) * 100) }))
    .filter((l) => Number.isFinite(l.usdCents) && l.usdCents > 0);

  const total = lines.reduce((s, l) => s + l.usdCents, 0);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createPayRun(period, lines);
      setMsg({
        tone: "ok",
        text: `${res.run.id} · ${usd(res.settledCents)} settled, ${res.approvals.length} held, ${res.denied.length} denied, ${res.needsReview.length} to review`,
      });
      setAmounts({});
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "pay run failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <div className="field">
        <label htmlFor="period">Period</label>
        <input
          id="period"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          placeholder="2026-11"
        />
      </div>

      {payees.length === 0 ? (
        <div className="empty">No approved payees yet.</div>
      ) : (
        payees.map((p) => (
          <div className="field" key={p.id}>
            <label htmlFor={`amt-${p.id}`}>
              {p.displayName} · {p.kind} · {p.destination.chain}
            </label>
            <input
              id={`amt-${p.id}`}
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amounts[p.id] ?? ""}
              onChange={(e) => setAmounts((a) => ({ ...a, [p.id]: e.target.value }))}
            />
          </div>
        ))
      )}

      <dl className="kv" style={{ marginTop: 4 }}>
        <dt>Lines</dt>
        <dd>{lines.length}</dd>
        <dt>Total</dt>
        <dd>{usd(total)}</dd>
      </dl>

      <button className="act act-dark" disabled={busy || lines.length === 0} onClick={submit}>
        {busy ? "Running…" : "Run pay run"}
      </button>

      {msg ? <div className={`banner ${msg.tone === "err" ? "err" : ""}`}>{msg.text}</div> : null}
    </div>
  );
}
