import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, CircleDollarSign, Inbox, RefreshCw, ShieldCheck } from "lucide-react";
import PageHeader from "@/components/common/PageHeader";
import Panel from "@/components/common/Panel";
import StatTile from "@/components/common/StatTile";
import NeedsHuman from "@/components/overview/NeedsHuman";
import RecentRuns from "@/components/overview/RecentRuns";
import WalletCard from "@/components/funding/WalletCard";
import { Button } from "@/components/ui/button";
import { money, moneyCompact } from "@/lib/format";
import { reasonLabels } from "@/lib/policy";
import useRecords from "@/hooks/useRecords";
import useWallet from "@/hooks/useWallet";

export const Route = createFileRoute("/_authed/app/")({
  component: Overview,
});

function Overview() {
  const { items: runs, loading: runsLoading, reload: reloadRuns } = useRecords("PayRun");
  const { items: approvals, loading: approvalsLoading, reload: reloadApprovals } = useRecords("Approval");
  const { items: worklist, loading: worklistLoading, reload: reloadWorklist } = useRecords("WorklistItem");
  const { items: lines, loading: linesLoading, reload: reloadLines } = useRecords("PayRunLine", {}, { limit: 500 });
  const { wallet, loading: walletLoading, error: walletError, reload: reloadWallet } = useWallet();
  const loading = runsLoading || approvalsLoading || worklistLoading || linesLoading;

  const model = useMemo(() => {
    const settledLines = lines.filter((line) => line.status === "settled");
    const held = approvals.filter((approval) => approval.status === "pending");
    // The worklist endpoint returns only unresolved records, so every row here
    // is open; there is no "resolved" state to filter on.
    const open = worklist;
    const totalCents = lines.reduce((sum, line) => sum + (line.amount_cents || 0), 0);
    const heldCents = held.reduce((sum, approval) => sum + (approval.amount_cents || 0), 0);
    const balanced =
      settledLines.every((line) => Boolean(line.tx_hash)) &&
      lines.filter((line) => line.status !== "settled").every((line) => !line.tx_hash);

    const human = [
      ...held.map((approval) => ({
        id: `a-${approval.id}`,
        title: approval.payee_name,
        reason: reasonLabels(approval.reasons).join(" · "),
        amount: money(approval.amount_cents),
        tone: "amber",
        href: "/app/approvals",
      })),
      ...open.map((item) => ({
        id: `w-${item.request_ref}`,
        title: `${item.kind} ${item.request_ref}`,
        reason: item.reason,
        amount: "",
        tone: item.status === "failed" ? "rose" : "amber",
        href: "/app/worklist",
      })),
    ].slice(0, 8);

    return { settledLines, held, open, totalCents, heldCents, balanced, human };
  }, [lines, approvals, worklist]);

  const tiles = [
    {
      label: "Settled",
      value: loading ? "—" : moneyCompact(model.totalCents),
      sub: loading ? "Reading the ledger…" : `${runs.length} runs · ${model.settledLines.length} ledger entries`,
      icon: CircleDollarSign,
      tone: "emerald",
    },
    {
      label: "Awaiting approval",
      value: loading ? "—" : String(model.held.length),
      sub: loading ? "Reading the inbox…" : `${money(model.heldCents)} held at the policy gate`,
      icon: ShieldCheck,
      tone: "amber",
    },
    {
      label: "Open questions",
      value: loading ? "—" : String(model.open.length),
      sub: loading ? "Reading the worklist…" : model.open.length ? "Funding requests unresolved" : "Every funding request resolved",
      icon: Inbox,
      tone: "rose",
    },
    {
      label: "Books",
      value: loading ? "—" : model.balanced ? "Balanced" : "Unbalanced",
      sub: loading
        ? "Checking entries…"
        : `${model.settledLines.length} entries · ${model.balanced ? "every settled leg has a tx" : "a settled leg is missing its tx"}`,
      icon: BookOpen,
      tone: "indigo",
    },
  ];

  async function refresh() {
    await Promise.all([reloadRuns(), reloadApprovals(), reloadWorklist(), reloadLines(), reloadWallet()]);
  }

  return (
    <>
      <PageHeader
        eyebrow="Operator console"
        title="Overview"
        description="The morning glance — what settled, what is waiting, and what needs a human."
        actions={
          <>
            <Button variant="outline" size="sm" className="h-9 rounded-xl" onClick={refresh}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
              Refresh
            </Button>
            <Button asChild size="sm" className="h-9 rounded-xl">
              <Link to="/app/pay-runs">
                New pay run
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" strokeWidth={2} />
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </div>

      <div className="mt-4">
        <WalletCard
          wallet={wallet}
          loading={walletLoading}
          error={walletError}
          onRefresh={reloadWallet}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Panel
          title="Needs a human"
          description="Approvals and unresolved funding, merged into one queue."
          action={
            <Link
              to="/app/approvals"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
            >
              Inbox
              <ArrowRight className="h-3 w-3" strokeWidth={2.2} />
            </Link>
          }
        >
          <NeedsHuman items={model.human} loading={approvalsLoading || worklistLoading} />
        </Panel>

        <Panel
          title="Recent runs"
          description="Latest batches and their settlement state."
          action={
            <Link
              to="/app/pay-runs"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
            >
              All runs
              <ArrowRight className="h-3 w-3" strokeWidth={2.2} />
            </Link>
          }
        >
          <RecentRuns runs={runs.slice(0, 5)} loading={runsLoading} />
        </Panel>
      </div>
    </>
  );
}