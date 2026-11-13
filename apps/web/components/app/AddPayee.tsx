"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";

const CHAINS = ["near", "base", "arbitrum", "ethereum", "solana"];
const ASSETS = ["usdc", "usdt", "dai"];

/** Create a payee. New payees start as draft + screening review, by design. */
export default function AddPayee() {
  const router = useRouter();
  const [form, setForm] = useState({
    id: "",
    displayName: "",
    kind: "contractor",
    chain: "near",
    asset: "usdc",
    address: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.id.trim() && form.displayName.trim() && form.address.trim();

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api.addPayee({
        id: form.id.trim(),
        displayName: form.displayName.trim(),
        kind: form.kind as "contractor" | "vendor" | "employee" | "agent",
        destination: { chain: form.chain, asset: form.asset },
        address: form.address.trim(),
      });
      setMsg({ tone: "ok", text: `${form.displayName} added as draft` });
      setForm({ ...form, id: "", displayName: "", address: "" });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "could not add payee" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <div className="field">
        <label htmlFor="payee-id">Payee id</label>
        <input id="payee-id" value={form.id} onChange={(e) => set("id", e.target.value)} placeholder="jane-doe" />
      </div>
      <div className="field">
        <label htmlFor="payee-name">Display name</label>
        <input
          id="payee-name"
          value={form.displayName}
          onChange={(e) => set("displayName", e.target.value)}
          placeholder="Jane Doe"
        />
      </div>
      <div className="field">
        <label htmlFor="payee-kind">Kind</label>
        <select id="payee-kind" value={form.kind} onChange={(e) => set("kind", e.target.value)}>
          <option value="contractor">contractor</option>
          <option value="vendor">vendor</option>
          <option value="employee">employee</option>
          <option value="agent">agent</option>
        </select>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="payee-chain">Chain</label>
          <select id="payee-chain" value={form.chain} onChange={(e) => set("chain", e.target.value)}>
            {CHAINS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="payee-asset">Asset</label>
          <select id="payee-asset" value={form.asset} onChange={(e) => set("asset", e.target.value)}>
            {ASSETS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="payee-addr">Address</label>
        <input
          id="payee-addr"
          value={form.address}
          onChange={(e) => set("address", e.target.value)}
          placeholder="jane.near"
        />
      </div>

      <button className="act act-dark" disabled={busy || !valid} onClick={submit}>
        {busy ? "Adding…" : "Add payee"}
      </button>

      {msg ? <div className={`banner ${msg.tone === "err" ? "err" : ""}`}>{msg.text}</div> : null}
    </div>
  );
}
