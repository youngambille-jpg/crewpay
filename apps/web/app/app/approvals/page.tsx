import ApprovalTable from "@/components/app/ApprovalTable";
import { Panel } from "@/components/app/Status";
import { api } from "@/lib/api";

/**
 * Approvals. The default view is everything, because the useful question is
 * "what is in this inbox", not "what is pending" — a decided item is still
 * worth seeing until it has executed.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const all = await api.approvals();
  const filtered = status ? all.filter((a) => a.status === status) : all;

  const pending = all.filter((a) => a.status === "pending").length;
  const approved = all.filter((a) => a.status === "approved").length;
  const executed = all.filter((a) => a.status === "executed").length;

  const filters = [
    { key: undefined, label: `All ${all.length}` },
    { key: "pending", label: `Pending ${pending}` },
    { key: "approved", label: `Approved ${approved}` },
    { key: "executed", label: `Executed ${executed}` },
  ];

  return (
    <main className="page">
      <Panel
        title="Approvals"
        count={filtered.length}
        right={
          <div style={{ display: "flex", gap: 8 }}>
            {filters.map((f) => (
              <a
                key={f.label}
                href={f.key ? `/app/approvals?status=${f.key}` : "/app/approvals"}
                className={`act ${status === f.key ? "act-dark" : "act-ghost"}`}
              >
                {f.label}
              </a>
            ))}
          </div>
        }
      >
        <ApprovalTable approvals={filtered} />
      </Panel>

      <p className="page-note">
        Approval clears the human gate only. Execute re-checks the current policy,
        so an approval can still go stale if the payee is blocked or a cap is
        lowered in between.
      </p>
    </main>
  );
}
