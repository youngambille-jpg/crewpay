import Status, { Panel } from "@/components/app/Status";
import PolicyForm from "@/components/app/PolicyForm";
import PublishPolicy from "@/components/app/PublishPolicy";
import { api, type ConnectState } from "@/lib/api";

/**
 * Policy: the rules in force, and the manifest they compile to for the custody
 * wallet. The manifest is what OutLayer actually enforces; the drift check
 * compares our compiled intent against the wallet's effective policy.
 *
 * Below both, the publish + dry-run panels take the rules all the way into the
 * enclave and test a withdraw against them without moving funds.
 */
export default async function PolicyPage() {
  const [manifest, policy, connect] = await Promise.all([
    api.manifest(),
    api.policy(),
    api.connectState().catch((): ConnectState => ({ connected: false })),
  ]);
  const m = manifest.manifest;

  return (
    <main className="page">
      <div className="split" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Panel title="Active policy" count={`v${manifest.policyVersion}`}>
          <div className="panel-body">
            <PolicyForm current={policy.rules} />
          </div>
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel
            title="Custody manifest"
            right={
              manifest.drift ? (
                <Status value="needs_review" label={`${manifest.drift.length} drift`} />
              ) : (
                <Status value="approved" label="no drift" />
              )
            }
          >
            <div className="panel-body">
              <dl className="kv">
                <dt>Per transaction</dt>
                <dd>{m.limits.per_transaction}</dd>
                <dt>Daily</dt>
                <dd>{m.limits.daily}</dd>
                <dt>Approval above</dt>
                <dd>{m.multisig.approval_above}</dd>
                <dt>Multisig</dt>
                <dd>
                  {m.multisig.threshold} of {m.multisig.approvers.length}
                </dd>
                <dt>Tokens</dt>
                <dd>{m.tokens.allowed.join(", ") || "none"}</dd>
                <dt>Chains</dt>
                <dd>{m.chains.allowed.length ? m.chains.allowed.join(", ") : "all known"}</dd>
              </dl>

              {manifest.drift && manifest.drift.length > 0 ? (
                <div className="banner err" style={{ marginTop: 16 }}>
                  Drift against the wallet's effective policy — the TEE would not
                  enforce what we intend.
                </div>
              ) : (
                <div className="banner" style={{ marginTop: 16 }}>
                  Compiled manifest matches the wallet's effective policy.
                </div>
              )}
            </div>
          </Panel>

          {manifest.warnings.length > 0 ? (
            <Panel title="Rules OutLayer cannot enforce" count={manifest.warnings.length}>
              <div className="panel-body">
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                  {manifest.warnings.map((w) => (
                    <li key={w} style={{ fontSize: 13, fontWeight: 500, color: "var(--smoke)" }}>
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          ) : null}
        </div>
      </div>

      <PublishPolicy rules={policy.rules} connect={connect} />

      <p className="page-note">
        Saving publishes a new version; it never edits the active one in place, so
        every past decision can be replayed against the rules that produced it.
      </p>
    </main>
  );
}
