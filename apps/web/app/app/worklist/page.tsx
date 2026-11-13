import WorklistTable from "@/components/app/WorklistTable";
import { Panel } from "@/components/app/Status";
import { api } from "@/lib/api";

/**
 * The funding worklist. Every row is a payment whose outcome is not knowable
 * from here, so it is deliberately the one screen where the product refuses to
 * guess.
 */
export default async function WorklistPage() {
  const records = await api.worklist();

  return (
    <main className="page">
      <Panel title="Funding worklist" count={records.length}>
        <WorklistTable records={records} />
      </Panel>

      <p className="page-note">
        Resolve only re-reads the custody service. It never re-submits, because a
        second submit could move the same money twice. A deposit landing is not a
        payment — we book a settlement only once the payee is actually paid.
      </p>
    </main>
  );
}
