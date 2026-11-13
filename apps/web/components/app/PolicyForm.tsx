"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type PolicyRules, usd } from "@/lib/api";

/**
 * Edit the active policy. Saving publishes a new version — the API bumps it
 * automatically, so a decision can always be traced to the rules in force when
 * it was made. There is no "edit in place".
 */
export default function PolicyForm({ current }: { current: PolicyRules }) {
  const router = useRouter();
  const [rules, setRules] = useState<PolicyRules>(current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const num = (k: keyof PolicyRules) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setRules((r) => ({ ...r, [k]: Math.round(Number(e.target.value) * 100) }));

  const agentCap = rules.perKindCents?.agent ?? 0;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const p = await api.setPolicy(rules);
      setMsg({ tone: "ok", text: `Published policy version ${p.version}` });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "could not publish policy" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <div className="form-row">
        <div className="field">
          <label htmlFor="max-txn">Max per transaction (USD)</label>
          <input
            id="max-txn"
            type="number"
            min="0"
            step="0.01"
            defaultValue={(rules.maxPerTransactionCents / 100).toFixed(2)}
            onChange={num("maxPerTransactionCents")}
          />
        </div>
        <div className="field">
          <label htmlFor="max-daily">Max daily (USD)</label>
          <input
            id="max-daily"
            type="number"
            min="0"
            step="0.01"
            defaultValue={(rules.maxDailyCents / 100).toFixed(2)}
            onChange={num("maxDailyCents")}
          />
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="approval-threshold">Approval above (USD)</label>
          <input
            id="approval-threshold"
            type="number"
            min="0"
            step="0.01"
            defaultValue={(rules.approvalThresholdCents / 100).toFixed(2)}
            onChange={num("approvalThresholdCents")}
          />
        </div>
        <div className="field">
          <label htmlFor="agent-cap">Agent per-task cap (USD)</label>
          <input
            id="agent-cap"
            type="number"
            min="0"
            step="0.01"
            defaultValue={(agentCap / 100).toFixed(2)}
            onChange={(e) =>
              setRules((r) => ({
                ...r,
                perKindCents: { ...r.perKindCents, agent: Math.round(Number(e.target.value) * 100) },
              }))
            }
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="new-payee">New payees</label>
        <select
          id="new-payee"
          value={rules.requireApprovalForNewPayee ? "yes" : "no"}
          onChange={(e) =>
            setRules((r) => ({ ...r, requireApprovalForNewPayee: e.target.value === "yes" }))
          }
        >
          <option value="yes">Always need approval</option>
          <option value="no">Pay without extra approval</option>
        </select>
      </div>

      <dl className="kv" style={{ marginTop: 4 }}>
        <dt>Per-transaction cap</dt>
        <dd>{usd(rules.maxPerTransactionCents)}</dd>
        <dt>Daily cap</dt>
        <dd>{usd(rules.maxDailyCents)}</dd>
        <dt>Approval threshold</dt>
        <dd>{usd(rules.approvalThresholdCents)}</dd>
      </dl>

      <button className="act act-dark" disabled={busy} onClick={save}>
        {busy ? "Publishing…" : "Publish new version"}
      </button>

      {msg ? <div className={`banner ${msg.tone === "err" ? "err" : ""}`}>{msg.text}</div> : null}
    </div>
  );
}
