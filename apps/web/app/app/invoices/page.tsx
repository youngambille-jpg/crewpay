import Status, { Panel } from "@/components/app/Status";
import NewInvoice from "@/components/app/NewInvoice";
import { api, ago, short, usd } from "@/lib/api";

/** Invoices: what customers owe, and whether Ping has settled it. */
export default async function InvoicesPage() {
  const [invoices, payees] = await Promise.all([api.invoices(), api.payees()]);
  const paid = invoices.filter((i) => i.status === "paid");
  const open = invoices.filter((i) => i.status === "open");

  return (
    <main className="page">
      <div className="split" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <Panel title="Invoices" count={invoices.length}>
          {invoices.length === 0 ? (
            <div className="empty">No invoices yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th className="num">Amount</th>
                  <th>Settles to</th>
                  <th>Status</th>
                  <th className="num">Created</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="mono strong">{i.id}</span>
                        <small className="mono">{short(i.checkoutSessionId, 12, 4)}</small>
                      </div>
                    </td>
                    <td className="strong">{i.customerId}</td>
                    <td className="num strong">{usd(i.amount)}</td>
                    <td className="muted">
                      {i.settlementAsset.chain}:{i.settlementAsset.asset}
                    </td>
                    <td>
                      <Status value={i.status} />
                    </td>
                    <td className="num muted">{ago(i.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel title="New invoice">
            <div className="panel-body">
              <NewInvoice payees={payees.filter((p) => p.status === "approved")} />
            </div>
          </Panel>

          <Panel title="Summary">
            <div className="panel-body">
              <dl className="kv">
                <dt>Collected</dt>
                <dd>{usd(paid.reduce((s, i) => s + i.amount, 0))}</dd>
                <dt>Outstanding</dt>
                <dd>{usd(open.reduce((s, i) => s + i.amount, 0))}</dd>
                <dt>Paid invoices</dt>
                <dd>{paid.length}</dd>
                <dt>Open invoices</dt>
                <dd>{open.length}</dd>
              </dl>
            </div>
          </Panel>
        </div>
      </div>

      <p className="page-note">
        A webhook is a claim; the checkout session is the truth. We re-read the
        session at Ping before releasing a pay run, so a replayed event cannot
        mark an unpaid invoice as paid.
      </p>
    </main>
  );
}
