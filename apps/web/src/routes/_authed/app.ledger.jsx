import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download, RefreshCw, Scale, ShieldAlert, FileCheck2 } from "lucide-react";
import { toast } from "sonner";
import PageHeader from "@/components/common/PageHeader";
import Notice from "@/components/common/Notice";
import StatTile from "@/components/common/StatTile";
import LedgerTables from "@/components/ledger/LedgerTables";
import { Button } from "@/components/ui/button";
import { shortHex } from "@/lib/format";
import { downloadJournalCsv, readLedger } from "@/lib/treasury";

export const Route = createFileRoute("/_authed/app/ledger")({
  component: LedgerPage,
});

/**
 * The ledger: the entries, the trial balance, and the attestation that pins the
 * export to an exact set of books. The API refuses to report an unbalanced
 * ledger, so an error here is a real integrity failure rather than a fetch
 * problem — the screen says so rather than showing a zero.
 */
function LedgerPage() {
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLedger(await readLedger());
    } catch (e) {
      setLedger(null);
      setError(e instanceof Error ? e : new Error("could not read the books"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadJournalCsv();
      toast.success("Journal exported");
    } catch (e) {
      toast.error(e?.message || "Could not export the journal");
    } finally {
      setExporting(false);
    }
  }

  const balanced = ledger?.balanced === true;
  const unbalanced = ledger?.unbalancedCurrencies;

  return (
    <>
      <PageHeader
        eyebrow="Proof"
        title="Ledger"
        description="Double-entry books: every settlement writes a balanced entry, and the export is pinned to a content hash."
        actions={
          <>
            <Button variant="outline" size="sm" className="h-9 rounded-xl" onClick={load}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
              Refresh
            </Button>
            <Button size="sm" className="h-9 rounded-xl" onClick={exportCsv} disabled={exporting || !ledger}>
              <Download className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </>
        }
      />

      {error ? (
        <div className="space-y-4">
          <Notice icon={ShieldAlert} title="Export refused" tone="amber">
            {error.message}
          </Notice>
          <Notice tone="slate" title="Why this is not a zero">
            The API refuses to report a ledger that does not balance rather than hand back books it cannot vouch for.
            A fetch problem and an unbalanced ledger are different failures; this one names the currency.
          </Notice>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatTile
              label="Trial balance"
              value={loading ? "—" : balanced ? "Balanced" : "Unbalanced"}
              sub={
                loading
                  ? "Reading the books…"
                  : balanced
                    ? `${ledger.entryCount} journal entries`
                    : `does not net to zero: ${(unbalanced ?? []).join(", ") || "unknown currency"}`
              }
              icon={Scale}
              tone={loading ? "slate" : balanced ? "emerald" : "rose"}
            />
            <StatTile
              label="Accounts"
              value={loading ? "—" : String(ledger.accountCount)}
              sub="distinct account/currency pairs"
              icon={FileCheck2}
              tone="indigo"
            />
            <StatTile
              label="Entries"
              value={loading ? "—" : String(ledger.entryCount)}
              sub="balanced journal entries"
              icon={FileCheck2}
              tone="indigo"
            />
            <StatTile
              label="Attestation"
              value={loading ? "—" : <span className="font-mono text-[15px]">{shortHex(ledger.attestation, 10, 6)}</span>}
              sub="sha-256 content hash of the export"
              icon={ShieldAlert}
              tone="slate"
            />
          </div>

          <div className="mt-4">
            <LedgerTables ledger={ledger} loading={loading} />
          </div>
        </>
      )}
    </>
  );
}
