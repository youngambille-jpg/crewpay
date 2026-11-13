import Status, { Panel } from "@/components/app/Status";
import PayAgent from "@/components/app/PayAgent";
import { api, ago, short, usd } from "@/lib/api";

/** Agent tasks: what an agent did, whether it was paid, and the receipt. */
export default async function AgentsPage() {
  const [tasks, payees, rollup] = await Promise.all([
    api.agentTasks(),
    api.payees(),
    api.agentExport(),
  ]);

  const agents = payees.filter((p) => p.kind === "agent" && p.status === "approved");
  const paid = tasks.filter((t) => t.status === "paid");

  return (
    <main className="page">
      <div className="split" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <Panel title="Agent tasks" count={tasks.length}>
          {tasks.length === 0 ? (
            <div className="empty">No agent tasks yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Agent</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Receipt</th>
                  <th className="num">Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="mono strong">{t.id}</span>
                        <small className="muted">{t.description ?? t.resourceUrl}</small>
                      </div>
                    </td>
                    <td className="strong">{t.payeeId}</td>
                    <td className="num strong">{usd(t.usdCents)}</td>
                    <td>
                      <Status value={t.status} />
                    </td>
                    <td className="mono muted">
                      {t.receipt ? short(t.receipt.operationToken, 10, 6) : t.note ?? "—"}
                    </td>
                    <td className="num muted">{ago(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel title="Pay a task">
            <div className="panel-body">
              <PayAgent agents={agents.map((a) => ({ id: a.id, displayName: a.displayName }))} />
            </div>
          </Panel>

          <Panel title={`1099-style roll-up · ${rollup.year}`}>
            <div className="panel-body">
              {rollup.rows.length === 0 ? (
                <div className="empty">No paid tasks this year.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="num">Payments</th>
                      <th className="num">Total</th>
                      <th>1099</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rollup.rows.map((r) => (
                      <tr key={r.payeeId}>
                        <td className="strong">{r.displayName}</td>
                        <td className="num">{r.payments}</td>
                        <td className="num strong">{r.totalUsd}</td>
                        <td>
                          <Status
                            value={r.meetsReportingThreshold ? "approved" : "draft"}
                            label={r.meetsReportingThreshold ? "over $600" : "under"}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        </div>
      </div>

      <p className="page-note">
        {paid.length} of {tasks.length} tasks paid, each with a terminal receipt.
        A denial is recorded as a failed task so nothing downstream mistakes it
        for something that could still pay.
      </p>
    </main>
  );
}
