"use client";

import { useEffect, useState } from "react";
import { api, short, type ConnectState, type LiveHealth } from "@/lib/api";

/**
 * The connect step. One button provisions a real OutLayer custody wallet — a
 * real NEAR account, real API key — and shows the real account id and the
 * provider's own handoff link.
 *
 * What it deliberately does NOT claim: that the wallet holds money. It is
 * created empty. The screen says so, because "connected" reading as "funded" is
 * the single most misleading thing this demo could do.
 */
export default function ConnectWallet({
  initial,
  health,
}: {
  initial: ConnectState;
  health: LiveHealth;
}) {
  const [state, setState] = useState<ConnectState>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The health prop is server-rendered; re-read on the client so the strip
  // reflects the connection that just happened, not the page load.
  const [live, setLive] = useState<LiveHealth>(health);

  useEffect(() => {
    api.liveHealth(false).then(setLive).catch(() => {});
  }, []);

  async function connect() {
    setBusy(true);
    setErr(null);
    try {
      const next = await api.connect();
      setState(next);
      // A fresh wallet changes what the rest of the app can do, so refresh the
      // cached views rather than leaving stale ones on screen.
      api.liveHealth(false).then(setLive).catch(() => {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not provision a wallet");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel-card">
        <div className="panel-head">
          <h2>Custody wallet</h2>
          <span className={`pill ${state.connected ? "pill-ok" : "pill-neutral"}`}>
            {state.connected ? "connected" : "not connected"}
          </span>
        </div>
        <div className="panel-body">
          {state.connected && state.wallet ? (
            <>
              <dl className="kv">
                <dt>NEAR account</dt>
                <dd className="mono">{short(state.wallet.nearAccountId, 16, 8)}</dd>
                <dt>Wallet id</dt>
                <dd className="mono">{short(state.wallet.walletId, 8, 4)}</dd>
                <dt>Balance</dt>
                <dd>
                  <span className="pill pill-warn">empty</span>
                </dd>
              </dl>
              <p className="page-note">
                This wallet is real and its key lives inside the provider&apos;s enclave. It holds
                nothing yet, so nothing can be broadcast from it. Everything below runs the real
                policy engine against it without moving funds.
              </p>
              {state.hasHandoff ? (
                <a
                  className="act act-outline"
                  href="/api/v1/connect/handoff"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in OutLayer dashboard ↗
                </a>
              ) : null}
            </>
          ) : (
            <>
              <p className="page-note">
                CrewPay never holds a private key. Connecting provisions a custody wallet whose key
                is generated and kept inside a hardware enclave; this service holds only an API key
                that can request signatures, never read them.
              </p>
              <button className="act act-dark" disabled={busy} onClick={connect}>
                {busy ? "Provisioning…" : "Create custody wallet"}
              </button>
            </>
          )}
          {err ? <div className="banner err">{err}</div> : null}
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <h2>Live infrastructure</h2>
          <span className={`pill ${live.allUp ? "pill-ok" : "pill-warn"}`}>
            {live.allUp ? "all reachable" : "degraded"}
          </span>
        </div>
        <div className="panel-body">
          <table className="table">
            <tbody>
              {live.services.map((s) => (
                <tr key={s.name}>
                  <td style={{ width: 110 }}>{s.name}</td>
                  <td>
                    <span
                      className={`pill ${s.status === "ok" ? "pill-ok" : "pill-bad"}`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="mono" style={{ color: "var(--fog)" }}>
                    {s.detail}
                  </td>
                  <td style={{ textAlign: "right", color: "var(--fog)" }}>{s.ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="page-note">
            Checked {new Date(live.checkedAt).toLocaleTimeString()} against the real endpoints —
            1Click&apos;s token feed, the OutLayer custody API, and Ping&apos;s x402 discovery. These
            are the actual services a payout would use.
          </p>
        </div>
      </div>
    </div>
  );
}
