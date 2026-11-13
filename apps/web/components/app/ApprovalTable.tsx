"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Status from "./Status";
import { api, type Approval, usd, short } from "@/lib/api";

/**
 * The approval inbox. The two decisions a human makes here are the whole point
 * of the product, so they are inline: approve/reject, then execute.
 *
 * Execute is a separate step on purpose — approval clears the human gate, and
 * execution re-checks the *current* policy. Collapsing them would hide that.
 */
export default function ApprovalTable({ approvals }: { approvals: Approval[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "action failed" });
    } finally {
      setBusy(null);
    }
  }

  if (approvals.length === 0) {
    return <div className="empty">No approvals match this filter.</div>;
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
            <th>Approval</th>
            <th>Payee</th>
            <th>Corridor</th>
            <th className="num">Amount</th>
            <th>Reason</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {approvals.map((a) => (
            <tr key={a.id}>
              <td>
                <div className="cell-stack">
                  <span className="mono strong">{a.id}</span>
                  <small className="mono">{a.operationId}</small>
                </div>
              </td>
              <td>
                <div className="cell-flex">
                  <span className="avatar">{a.payeeId.slice(0, 1).toUpperCase()}</span>
                  <div className="cell-stack">
                    <span className="strong">{a.payeeId}</span>
                    <small className="mono">{short(a.operation.recipient, 8, 6)}</small>
                  </div>
                </div>
              </td>
              <td className="muted mono">{a.operation.corridor}</td>
              <td className="num strong">{usd(a.operation.usdCents)}</td>
              <td>
                <div className="chips">
                  {a.reasonCodes.map((r) => (
                    <span className="chip-tag" key={r}>
                      {r.replace(/_/g, " ").toLowerCase()}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <Status value={a.status} />
              </td>
              <td className="num">
                <div className="row-actions">
                  {a.status === "pending" ? (
                    <>
                      <button
                        className="act act-dark"
                        disabled={busy === a.id}
                        onClick={() => run(a.id, () => api.decide(a.id, "approve"), `${a.id} approved`)}
                      >
                        Approve
                      </button>
                      <button
                        className="act act-danger"
                        disabled={busy === a.id}
                        onClick={() => run(a.id, () => api.decide(a.id, "reject", "rejected in dashboard"), `${a.id} rejected`)}
                      >
                        Reject
                      </button>
                    </>
                  ) : a.status === "approved" ? (
                    <button
                      className="act act-dark"
                      disabled={busy === a.id}
                      onClick={() => run(a.id, () => api.execute(a.id), `${a.id} executed`)}
                    >
                      Execute
                    </button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
