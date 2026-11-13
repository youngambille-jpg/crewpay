"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, usd } from "@/lib/api";

/** Issue an invoice backed by a Ping hosted checkout. */
export default function NewInvoice({ payees }: { payees: { id: string; displayName: string }[] }) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState("");
  const [autoPayeeId, setAutoPayeeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const cents = Math.round(Number(amount) * 100);
  const valid = customerId.trim() && Number.isFinite(cents) && cents > 0;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const inv = await api.createInvoice(customerId.trim(), cents, autoPayeeId || undefined);
      setMsg({ tone: "ok", text: `${inv.id} created · ${usd(inv.amount)} · ${inv.status}` });
      setCustomerId("");
      setAmount("");
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "could not create invoice" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <div className="field">
        <label htmlFor="inv-customer">Customer</label>
        <input
          id="inv-customer"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          placeholder="acme-corp"
        />
      </div>
      <div className="field">
        <label htmlFor="inv-amount">Amount (USD)</label>
        <input
          id="inv-amount"
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="1500.00"
        />
      </div>
      <div className="field">
        <label htmlFor="inv-payee">Auto pay run to (optional)</label>
        <select id="inv-payee" value={autoPayeeId} onChange={(e) => setAutoPayeeId(e.target.value)}>
          <option value="">None — collect only</option>
          {payees.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>

      <button className="act act-dark" disabled={busy || !valid} onClick={submit}>
        {busy ? "Creating…" : "Create invoice"}
      </button>

      {msg ? <div className={`banner ${msg.tone === "err" ? "err" : ""}`}>{msg.text}</div> : null}
    </div>
  );
}
