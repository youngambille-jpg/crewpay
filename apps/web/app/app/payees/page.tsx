import Status, { Panel } from "@/components/app/Status";
import { api, short } from "@/lib/api";
import AddPayee from "@/components/app/AddPayee";

/** Payees: who can be paid, on what chain, and whether they are payable. */
export default async function PayeesPage() {
  const payees = await api.payees();

  const byKind = payees.reduce<Record<string, number>>((acc, p) => {
    acc[p.kind] = (acc[p.kind] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="page">
      <div className="split" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <Panel
          title="Payees"
          count={payees.length}
          right={
            <div style={{ display: "flex", gap: 6 }}>
              {Object.entries(byKind).map(([k, n]) => (
                <span className="chip-tag" key={k}>
                  {k} {n}
                </span>
              ))}
            </div>
          }
        >
          {payees.length === 0 ? (
            <div className="empty">No payees yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th>Kind</th>
                  <th>Destination</th>
                  <th>Address</th>
                  <th>Screening</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payees.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-flex">
                        <span className="avatar">{p.displayName.slice(0, 1).toUpperCase()}</span>
                        <div className="cell-stack">
                          <span className="strong">{p.displayName}</span>
                          <small className="mono">{p.id}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="chip-tag">{p.kind}</span>
                    </td>
                    <td className="muted">
                      {p.destination.chain}:{p.destination.asset}
                    </td>
                    <td className="mono muted">{short(p.address, 8, 6)}</td>
                    <td>
                      <Status value={p.screening} />
                    </td>
                    <td>
                      <Status value={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Add payee">
          <div className="panel-body">
            <AddPayee />
          </div>
        </Panel>
      </div>

      <p className="page-note">
        A new payee is created as <strong>draft</strong> with screening{" "}
        <strong>review</strong>. Only an approved payee is payable without review;
        a blocked payee is never payable.
      </p>
    </main>
  );
}
