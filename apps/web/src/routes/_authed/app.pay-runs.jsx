import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import PageHeader from "@/components/common/PageHeader";
import Panel from "@/components/common/Panel";
import PayRunsTable from "@/components/payruns/PayRunsTable";
import RunLines from "@/components/payruns/RunLines";
import NewRunForm from "@/components/payruns/NewRunForm";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import useRecords from "@/hooks/useRecords";

export const Route = createFileRoute("/_authed/app/pay-runs")({
  validateSearch: (search) => ({ run: typeof search.run === "string" ? search.run : undefined }),
  component: PayRunsPage,
});

function PayRunsPage() {
  const search = Route.useSearch();
  const { items: runs, loading: runsLoading, reload: reloadRuns } = useRecords("PayRun");
  const { items: payees } = useRecords("Payee", {}, { sort: "name" });
  const { items: lines, loading: linesLoading, reload: reloadLines } = useRecords("PayRunLine", {}, { limit: 500 });
  const [selectedId, setSelectedId] = useState(search.run ?? null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const linesRef = useRef(null);

  function selectRun(id) {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => linesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  useEffect(() => {
    if (search.run) setSelectedId(search.run);
  }, [search.run]);

  useEffect(() => {
    if (!selectedId && runs.length) setSelectedId(runs[0].id);
  }, [runs, selectedId]);

  const selectedRun = runs.find((run) => run.id === selectedId) ?? null;
  const runLines = useMemo(() => lines.filter((line) => line.run_id === selectedId), [lines, selectedId]);

  async function handleCreated(run) {
    await Promise.all([reloadRuns(), reloadLines()]);
    setSelectedId(run.id);
    setSheetOpen(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Core screen"
        title="Pay runs"
        description="Every run is a batch of deterministic decisions — some lines settle, some hold, some are denied."
        actions={
          <Button className="h-9 rounded-xl lg:hidden" onClick={() => setSheetOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" strokeWidth={2.2} />
            New pay run
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]">
        <div className="min-w-0 space-y-4">
          <Panel title="Runs" description="Newest first — select a run to read its decisions.">
            <PayRunsTable runs={runs} loading={runsLoading} selectedId={selectedId} onSelect={selectRun} />
          </Panel>

          <div ref={linesRef} className="scroll-mt-20">
            <RunLines run={selectedRun} lines={runLines} loading={linesLoading} />
          </div>
        </div>

        <div className="hidden lg:block">
          <div className="card-surface sticky top-6 p-4">
            <h2 className="text-[15px] font-semibold tracking-tight">New pay run</h2>
            <p className="mb-3 mt-0.5 text-xs text-muted-foreground">A period plus funded lines.</p>
            <NewRunForm payees={payees} onCreated={handleCreated} />
          </div>
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-[420px]">
          <SheetHeader className="border-b hairline px-5 py-4 text-left">
            <SheetTitle className="text-[17px] tracking-[-0.01em]">New pay run</SheetTitle>
            <SheetDescription className="text-[12px]">A period plus funded lines.</SheetDescription>
          </SheetHeader>
          <div className="px-5 py-4">
            <NewRunForm payees={payees} onCreated={handleCreated} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}