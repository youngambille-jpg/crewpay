"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, usd } from "@/lib/api";

/**
 * Pay an agent for a completed task. The payout runs through the same policy
 * gate as a payroll line — the agent gets no special path.
 */
export default function PayAgent({ agents }: { agents: { id: string; displayName: string }[] }) {
  const router = useRouter();
  const [payeeId, setPayeeId] = useState(agents[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [resourceUrl, setResourceUrl] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const cents = Math.round(Number(amount) * 100);
  const valid = payeeId && Number.isFinite(cents) && cents > 0 && resourceUrl.trim();

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.payAgentTask(payeeId, cents, resourceUrl.trim(), description || undefined);
      setMsg({
        tone: res.status === "paid" ? "ok" : "err",
        text:
          res.status === "paid"
            ? `${res.task.id} paid · receipt ${res.task.receipt?.operationToken.slice(0, 12) ?? "—"}`
            : `${res.task.id} → ${res.status}${res.reasons ? ` (${res.reasons.join(", ")})` : ""}`,
      });
      setAmount("");
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "payout failed" });
    } finally {
      setBusy(false);
    }
  }

  if (agents.length === 0) {
    return <div className="empty">No agent payees yet. Add one with kind “agent”.</div>;
  }

  return (
    <div className="form">
      <div className="field">
        <label htmlFor="agent-payee">Agent payee</label>
        <select id="agent-payee" value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="agent-url">Resource URL</label>
        <input
          id="agent-url"
          value={resourceUrl}
          onChange={(e) => setResourceUrl(e.target.value)}
          placeholder="https://api.example.com/agent/infer"
        />
      </div>
      <div className="field">
        <label htmlFor="agent-desc">Description</label>
        <input
          id="agent-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="batch inference job"
        />
      </div>
      <div className="field">
        <label htmlFor="agent-amount">Amount (USD)</label>
        <input
          id="agent-amount"
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="200.00"
        />
      </div>

      <button className="act act-dark" disabled={busy || !valid} onClick={submit}>
        {busy ? "Paying…" : "Pay task"}
      </button>

      {msg ? <div className={`banner ${msg.tone === "err" ? "err" : ""}`}>{msg.text}</div> : null}
    </div>
  );
}
