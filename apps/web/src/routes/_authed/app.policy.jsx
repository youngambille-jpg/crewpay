import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import PageHeader from "@/components/common/PageHeader";
import Panel from "@/components/common/Panel";
import Notice from "@/components/common/Notice";
import LoadingRow from "@/components/common/LoadingRow";
import PolicyForm from "@/components/policy/PolicyForm";
import ManifestPanel from "@/components/policy/ManifestPanel";
import { Button } from "@/components/ui/button";
import { readManifest, readPolicy } from "@/lib/treasury";

export const Route = createFileRoute("/_authed/app/policy")({
  component: PolicyPage,
});

/**
 * Policy: the rules in force and the manifest they compile to for the custody
 * wallet. The manifest is what OutLayer actually enforces, so the screen shows
 * both — the rules we author, and the honest subset that reached the enclave.
 *
 * Both reads go through the token proxy; neither the policy nor the manifest is
 * cached in the browser.
 */
function PolicyPage() {
  const [policy, setPolicy] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [policyError, setPolicyError] = useState(null);
  const [manifestError, setManifestError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setManifestLoading(true);
    setPolicyError(null);
    setManifestError(null);

    // Independent reads: a manifest that needs approvers can still be shown
    // even when no policy exists yet, and a missing policy must not hide the
    // manifest error. Settle each on its own.
    const [policyResult, manifestResult] = await Promise.allSettled([readPolicy(), readManifest()]);

    if (policyResult.status === "fulfilled") setPolicy(policyResult.value);
    else {
      setPolicy(null);
      // "No active policy" is an empty state, not a failure: the form must
      // still render so the operator can publish v1. Anything else is a real
      // read error and is surfaced.
      const reason = policyResult.reason instanceof Error ? policyResult.reason : new Error("could not read policy");
      setPolicyError(/\b404\b/.test(reason.message) ? null : reason);
    }

    if (manifestResult.status === "fulfilled") setManifest(manifestResult.value);
    else {
      setManifest(null);
      setManifestError(
        manifestResult.reason instanceof Error ? manifestResult.reason : new Error("could not compile manifest"),
      );
    }

    setLoading(false);
    setManifestLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader
        eyebrow="Constraints"
        title="Policy"
        description="The deterministic rules every line passes before money moves, and the custody manifest they compile to."
        actions={
          <Button variant="outline" size="sm" className="h-9 rounded-xl" onClick={load}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Active policy"
          description={policy ? `Version ${policy.version} · ${policy.policy_ref}` : "No active policy for this org"}
        >
          {loading ? (
            <LoadingRow label="Reading the active policy…" />
          ) : policyError ? (
            <div className="p-4 sm:p-5">
              <Notice title="Could not read the policy" tone="amber">
                {policyError.message} — the API may not have an active policy yet. Publishing below creates v1.
              </Notice>
            </div>
          ) : (
            <PolicyForm policy={policy} onPublished={() => load()} />
          )}
        </Panel>

        <Panel
          title="Custody manifest"
          description="The rules that reached the enclave — and the ones that did not."
        >
          <ManifestPanel manifest={manifest} loading={manifestLoading} error={manifestError} />
        </Panel>
      </div>
    </>
  );
}
