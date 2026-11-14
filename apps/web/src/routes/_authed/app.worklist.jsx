import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import PageHeader from "@/components/common/PageHeader";
import Panel from "@/components/common/Panel";
import Notice from "@/components/common/Notice";
import WorklistTable from "@/components/worklist/WorklistTable";
import ResolveSheet from "@/components/worklist/ResolveSheet";
import { Lock } from "lucide-react";
import useRecords from "@/hooks/useRecords";

export const Route = createFileRoute("/_authed/app/worklist")({
  component: WorklistPage,
});

function WorklistPage() {
  const { items, loading, reload } = useRecords("WorklistItem");
  const [selected, setSelected] = useState(null);

  // The API filters resolved records out of this list, so every row is open.
  // There is no "resolved" row state to count here.
  const open = items;

  return (
    <>
      <PageHeader
        eyebrow="Funding"
        title="Worklist"
        description="Funding requests whose outcome is unresolved — needs review or unsafe failures."
      />

      <div className="space-y-4">
        <Notice icon={Lock} title="Resolving is read-only" tone="indigo">
          It re-reads the true state and never re-submits the original operation. No request is retried from this screen.
        </Notice>

        <Panel
          title="Open questions"
          description={
            open.length ? `${open.length} still open` : "Nothing unresolved"
          }
        >
          <WorklistTable items={open} loading={loading} onOpen={setSelected} />
        </Panel>
      </div>

      <ResolveSheet
        item={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        onResolved={reload}
      />
    </>
  );
}