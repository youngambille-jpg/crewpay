"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type FundingRecord, ago, label } from "@/lib/api";

/**
 * The funding worklist. These are payments whose outcome is unknown — the funds
 * may have moved. Resolve re-reads the custody service; it never re-submits,
 * because a second submit could send the money twice.
 */
export default function WorklistTable({ records }: { records: FundingRecord[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function resolve(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const res = await api.resolveFunding(id);
      setMsg({
        tone: res.resolved ? "ok" : "err",
        text: res.resolved
          ? `${id} → ${res.outcome}${res.duplicate ? " (already answered)" : ""}`
          : `${id} is still open: ${res.reason ?? "unknown state"}`,
      });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "resolve failed" });
    } finally {
      setBusy(null);
    }
  }

  if (records.length === 0) {
    return <div className="empty">The worklist is clear — no unresolved funding.</div>;
  }

  return (
    <>
      {msg ? (
        <div className={`banner ${msg.tone === "err" ? "err" : ""}`} style={{ margin: 20 }}>
          {msg.text}
        </div>
      ) : null}
      <table className="table">
        <thead>
          <tr>
            <th>Request</th>
            <th>Operation</th>
            <th>Kind</th>
            <th>Reason</th>
            <th>Rail</th>
            <th className="num">Age</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.requestId}>
              <td className="mono strong">{r.requestId}</td>
              <td>
                <div className="cell-stack">
                  <span className="mono">{r.operationId}</span>
                  <small>{r.payeeId ?? "—"}</small>
                </div>
              </td>
              <td>
                <span className="pill pill-warn">{label(r.kind)}</span>
              </td>
              <td className="muted">{r.reason || "—"}</td>
              <td className="muted">{r.settlesVia ?? "rail"}</td>
              <td className="num muted">{ago(r.createdAt)}</td>
              <td className="num">
                <button
                  className="act act-dark"
                  disabled={busy === r.requestId}
                  onClick={() => resolve(r.requestId)}
                >
                  {busy === r.requestId ? "Reading…" : "Resolve"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
