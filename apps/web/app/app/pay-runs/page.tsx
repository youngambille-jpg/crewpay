import Status, { Panel } from "@/components/app/Status";
import { api, ago, usd } from "@/lib/api";
import NewPayRun from "@/components/app/NewPayRun";

/** Pay runs: the run, its lines, and each line's outcome. */
export default async function PayRunsPage() {
  const [runs, payees] = await Promise.all([api.payRuns(), api.payees()]);

  return (
    <main className="page">
      <div className="split" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <Panel title="Pay runs" count={runs.length}>
          {runs.length === 0 ? (
            <div className="empty">No pay runs yet. Start one on the right.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Period</th>
                  <th className="num">Lines</th>
                  <th className="num">Value</th>
                  <th>Status</th>
                  <th className="num">Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const valueCents = r.items.reduce(
                    (s, i) => s + Number(i.amount.amount) / 10_000,
                    0,
                  );
                  const settled = r.items.filter((i) => i.state === "settled").length;
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="cell-stack">
                          <span className="mono strong">{r.id}</span>
                          <small>
                            {settled}/{r.items.length} settled · {r.source}
                          </small>
                        </div>
                      </td>
                      <td className="muted">{r.period}</td>
                      <td className="num">{r.items.length}</td>
                      <td className="num strong">{usd(valueCents)}</td>
                      <td>
                        <Status value={r.status} />
                      </td>
                      <td className="num muted">{ago(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="New pay run">
          <div className="panel-body">
            <NewPayRun payees={payees.filter((p) => p.status === "approved")} />
          </div>
        </Panel>
      </div>

      {runs.length > 0 ? (
        <Panel title="Line outcomes" count={runs[0]!.id}>
          <table className="table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Payee</th>
                <th>Corridor</th>
                <th className="num">Amount</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {runs[0]!.items.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.operationId ?? i.id}</td>
                  <td className="strong">{i.payeeId}</td>
                  <td className="muted mono">{i.corridor}</td>
                  <td className="num">{usd(Number(i.amount.amount) / 10_000)}</td>
                  <td>
                    <Status value={i.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </main>
  );
}
