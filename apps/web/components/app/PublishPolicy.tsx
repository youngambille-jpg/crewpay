"use client";

import { useState } from "react";
import {
  api,
  label,
  short,
  type ConnectState,
  type DryRunResult,
  type PolicyRules,
  type PublishResult,
} from "@/lib/api";

/**
 * Publish the policy into custody, then prove it — without moving money.
 *
 * Two steps, both real:
 *
 *   1. Compile. `POST /v1/policies/publish` sends the org's rules to the
 *      provider's enclave, which returns an encrypted blob and a signature. The
 *      plaintext rules never leave in the clear; the ciphertext is what gets
 *      stored on-chain.
 *
 *   2. Dry-run. `POST /v1/live/dry-run` runs the enclave's own policy and
 *      balance check against a proposed withdraw and returns its verdict, with
 *      no signing and no broadcast.
 *
 * The honest caveat, shown in the UI rather than buried: storing the compiled
 * policy on-chain is a NEAR transaction and needs a funded account. Until that
 * happens the enclave reports no policy, so `within_limits: true` means nothing
 * refused the withdraw — not yet that *our* limits allowed it.
 */
export default function PublishPolicy({
  rules,
  connect,
}: {
  rules: PolicyRules;
  connect: ConnectState;
}) {
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState<"publish" | "dry" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // A small withdraw for the dry-run: below any sane cap, so the verdict turns
  // on policy rather than on the amount.
  const [amount, setAmount] = useState("1000000000000000000000000");
  const [to, setTo] = useState("crewpay.near");

  async function publish() {
    setBusy("publish");
    setErr(null);
    try {
      setPublished(await api.publishPolicy(rules));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not compile the policy");
    } finally {
      setBusy(null);
    }
  }

  async function runDryRun() {
    setBusy("dry");
    setErr(null);
    try {
      setDryRun(await api.dryRun({ chain: "near", amount, to }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "dry-run failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" style={{ maxWidth: "none" }}>
      <div className="panel-card">
        <div className="panel-head">
          <h2>Publish into custody</h2>
          <span className="spacer" />
          {published ? (
            <span className="pill pill-info">
              {published.policyState === "stored" ? "enforced on-chain" : "compiled"}
            </span>
          ) : null}
        </div>
        <div className="panel-body">
          <p className="page-note" style={{ marginBottom: 14 }}>
            The rules above compile into an encrypted policy the enclave evaluates. The plaintext
            never leaves this screen; only the ciphertext is stored on-chain.
          </p>
          <button className="act act-dark" disabled={busy !== null} onClick={publish}>
            {busy === "publish" ? "Compiling…" : "Compile & sign policy"}
          </button>

          {published ? (
            <>
              <dl className="kv" style={{ marginTop: 16 }}>
                <dt>Ciphertext</dt>
                <dd className="mono">{published.ciphertextBytes} bytes</dd>
                <dt>Policy hash</dt>
                <dd className="mono">{short(published.signed.policyHash, 18, 8)}</dd>
                <dt>Version</dt>
                <dd>v{published.signed.version}</dd>
                <dt>State</dt>
                <dd>
                  <span className="pill pill-warn">{published.policyState}</span>
                </dd>
              </dl>
              <p className="page-note" style={{ marginTop: 8 }}>
                {published.note}
              </p>
            </>
          ) : null}
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <h2>Test a withdraw</h2>
          <span className="pill pill-ok">no funds moved</span>
        </div>
        <div className="panel-body">
          <p className="page-note" style={{ marginBottom: 14 }}>
            This asks the enclave what it would do with a real withdraw — policy check, balance
            check — and returns its verdict. Nothing is signed and nothing is broadcast.
          </p>

          <div className="form-row">
            <div className="field">
              <label htmlFor="dry-to">Recipient</label>
              <input id="dry-to" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dry-amount">Amount (yoctoNEAR)</label>
              <input id="dry-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>

          <button
            className="act act-dark"
            disabled={busy !== null || !connect.connected}
            onClick={runDryRun}
            title={connect.connected ? undefined : "Connect a custody wallet first"}
          >
            {busy === "dry" ? "Asking the enclave…" : "Run dry-run"}
          </button>
          {!connect.connected ? (
            <p className="page-note" style={{ marginTop: 8 }}>
              A custody wallet is required. Connect one first.
            </p>
          ) : null}

          {dryRun ? (
            <>
              <dl className="kv" style={{ marginTop: 16 }}>
                <dt>Would succeed</dt>
                <dd>
                  <span className={`pill ${dryRun.wouldSucceed ? "pill-ok" : "pill-warn"}`}>
                    {dryRun.wouldSucceed ? "yes" : "no"}
                  </span>
                </dd>
                {dryRun.reason ? (
                  <>
                    <dt>Reason</dt>
                    <dd className="mono">{label(dryRun.reason)}</dd>
                  </>
                ) : null}
                {dryRun.policyCheck ? (
                  <>
                    <dt>Within limits</dt>
                    <dd>
                      <span
                        className={`pill ${dryRun.policyCheck.withinLimits ? "pill-ok" : "pill-bad"}`}
                      >
                        {dryRun.policyCheck.withinLimits ? "yes" : "no"}
                      </span>
                    </dd>
                    <dt>Address allowed</dt>
                    <dd>
                      <span
                        className={`pill ${
                          dryRun.policyCheck.addressAllowed ? "pill-ok" : "pill-bad"
                        }`}
                      >
                        {dryRun.policyCheck.addressAllowed ? "yes" : "no"}
                      </span>
                    </dd>
                  </>
                ) : null}
              </dl>

              {/* The single most important sentence on this screen. */}
              <div className="banner" style={{ marginTop: 12 }}>
                {published?.policyState === "stored"
                  ? "The enclave enforces the policy you published, so this verdict reflects your own limits."
                  : "The enclave reports no stored policy, so a pass here means nothing refused it — not yet that your limits allowed it. Storing the policy on-chain needs a funded account."}
              </div>
              {dryRun.message ? (
                <p className="page-note" style={{ marginTop: 8 }}>
                  {dryRun.message}
                </p>
              ) : null}
            </>
          ) : null}

          {err ? <div className="banner err" style={{ marginTop: 12 }}>{err}</div> : null}
        </div>
      </div>
    </div>
  );
}
