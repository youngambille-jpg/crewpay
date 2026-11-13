import Status, { Panel, Tile } from "@/components/app/Status";
import { api, ago, label, usd } from "@/lib/api";

/** The ledger: entries, the trial balance, and the attestation that pins it. */
export default async function LedgerPage() {
  const ledger = await api.ledger();

  const debits = ledger.trialBalance.reduce((s, r) => s + Number(r.debit), 0);
  const credits = ledger.trialBalance.reduce((s, r) => s + Number(r.credit), 0);

  return (
    <main className="page">
      <div className="tiles">
        <Tile
          k="Trial balance"
          v={ledger.balanced ? "Balanced" : "Unbalanced"}
          sub={`${ledger.entryCount} journal entries`}
          accent={ledger.balanced}
        />
        <Tile k="Debits" v={usd(debits / 10_000)} sub="sum of all debits" />
        <Tile k="Credits" v={usd(credits / 10_000)} sub="sum of all credits" />
        <Tile
          k="Attestation"
          v={<span className="mono" style={{ fontSize: 15 }}>{ledger.attestation.slice(0, 14)}</span>}
          sub="content hash of the export"
        />
      </div>

      {!ledger.balanced ? (
        <div className="banner err">
          The books do not balance: {ledger.unbalancedCurrencies?.join(", ") ?? "unknown currency"}.
          Export refused rather than reported.
        </div>
      ) : null}

      <Panel title="Trial balance" count={`${ledger.trialBalance.length} accounts`}>
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Currency</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {ledger.trialBalance.map((r) => (
              <tr key={`${r.currency}-${r.account}`}>
                <td className="mono strong">{r.account}</td>
                <td className="muted">{r.currency}</td>
                <td className="num muted">{r.debit}</td>
                <td className="num muted">{r.credit}</td>
                <td className="num strong">{r.balance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Journal entries" count={ledger.entries.length}>
        {ledger.entries.length === 0 ? (
          <div className="empty">No entries yet — run a pay run to write the books.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Entry</th>
                <th>Kind</th>
                <th>Memo</th>
                <th>Postings</th>
                <th className="num">When</th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((e) => (
                <tr key={e.id}>
                  <td className="mono strong">{e.id}</td>
                  <td>
                    <span className="chip-tag">{label(e.kind)}</span>
                  </td>
                  <td className="muted">{e.memo}</td>
                  <td>
                    <div className="cell-stack">
                      {e.postings.map((p, i) => (
                        <small className="mono" key={i}>
                          {p.direction} {p.amount} {p.currency} · {p.account}
                        </small>
                      ))}
                    </div>
                  </td>
                  <td className="num muted">{ago(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </main>
  );
}
