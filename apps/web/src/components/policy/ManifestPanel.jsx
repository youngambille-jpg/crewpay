import { AlertTriangle, ShieldCheck } from "lucide-react";
import EmptyState from "@/components/common/EmptyState";
import LoadingRow from "@/components/common/LoadingRow";
import Notice from "@/components/common/Notice";
import StatusChip from "@/components/common/StatusChip";
import { manifestWarningLabel } from "@/lib/status";

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b hairline px-4 py-2.5 last:border-b-0 sm:px-5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-[12.5px] font-medium tabular">{children}</dd>
    </div>
  );
}

function Chips({ values, empty }) {
  if (!values?.length) return <span className="text-[12px] text-muted-foreground">{empty}</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {values.map((value) => (
        <span key={value} className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
          {value}
        </span>
      ))}
    </span>
  );
}

/**
 * The manifest OutLayer enforces, plus the two things that make it trustworthy:
 * the warnings naming every rule that did NOT travel (so the manifest never
 * looks stronger than it is), and the drift between our compiled intent and the
 * wallet's own policy. Drift is reported, never corrected — the wallet's policy
 * is the owner's, and silently rewriting it would defeat the point.
 */
export default function ManifestPanel({ manifest, loading, error }) {
  if (loading) return <LoadingRow label="Compiling the custody manifest…" />;
  if (error) {
    return (
      <div className="p-4 sm:p-5">
        <Notice title="No manifest" tone="amber">
          {error.message}
        </Notice>
      </div>
    );
  }
  if (!manifest) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No compiled manifest"
        note="Publish a policy to compile the custody manifest it maps to."
      />
    );
  }

  const drift = manifest.drift;

  return (
    <div className="divide-y hairline">
      <dl>
        <Row label="Per transaction">{manifest.per_transaction ?? "—"}</Row>
        <Row label="Daily">{manifest.daily ?? "—"}</Row>
        <Row label="Approval above">{manifest.approval_above ?? "—"}</Row>
        <Row label="Multisig">
          {manifest.threshold} of {manifest.approvers.length || 0}
        </Row>
        <Row label="Approvers">
          <Chips values={manifest.approvers} empty="none configured" />
        </Row>
        <Row label="Tokens">
          <Chips values={manifest.tokens} empty="none" />
        </Row>
        <Row label="Chains">
          <Chips values={manifest.chains} empty="all known" />
        </Row>
        <Row label="Transaction types">
          <Chips values={manifest.transaction_types} empty="none" />
        </Row>
      </dl>

      {drift ? (
        <div className="p-4 sm:p-5">
          {drift.length === 0 ? (
            <div className="flex items-center gap-2">
              <StatusChip kind="approval" value="executed" label="No drift" />
              <span className="text-[12px] text-muted-foreground">
                The wallet's policy matches what we compiled.
              </span>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <StatusChip kind="worklist" value="needs_review" label={`${drift.length} drift`} />
                <span className="text-[12px] text-muted-foreground">
                  The wallet enforces its owner's policy, which differs from ours.
                </span>
              </div>
              <ul className="space-y-1.5">
                {drift.map((item) => (
                  <li key={item.field} className="rounded-lg border hairline bg-secondary/40 px-3 py-2">
                    <p className="font-mono text-[11px] text-muted-foreground">{item.field}</p>
                    <p className="mt-0.5 text-[12px]">
                      <span className="text-muted-foreground">we propose </span>
                      <span className="font-mono">{item.expected}</span>
                      <span className="text-muted-foreground"> · wallet has </span>
                      <span className="font-mono">{item.actual}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="p-4 sm:p-5">
          <Notice tone="slate" title="Drift not checked">
            No custody signer is configured, so there is no wallet policy to compare against. The manifest stands
            alone.
          </Notice>
        </div>
      )}

      {manifest.warnings?.length ? (
        <div className="p-4 sm:p-5">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" strokeWidth={2} />
            <h3 className="text-[12px] font-semibold">
              {manifest.warnings.length} rule{manifest.warnings.length === 1 ? "" : "s"} not carried to OutLayer
            </h3>
          </div>
          <ul className="space-y-1.5">
            {manifest.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} className="text-[11.5px] leading-relaxed text-muted-foreground">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-amber-700">
                  {warning.code}
                </span>
                <br />
                {manifestWarningLabel(warning.code, warning.detail)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
