import Link from "next/link";
import Status, { Panel, Tile } from "@/components/app/Status";
import { api, ago, label, short, usd } from "@/lib/api";

/**
 * The overview: what needs a human, what moved, and whether the books agree.
 * Everything on this page is read from the live API. Where a fetch fails the
 * page says so instead of showing a zero that would read as "nothing wrong".
 */
export default async function Overview() {
  let error: string | null = null;
  let approvals: Awaited<ReturnType<typeof api.approvals>> = [];
  let worklist: Awaited<ReturnType<typeof api.worklist>> = [];
  let runs: Awaited<ReturnType<typeof api.payRuns>> = [];
  let ledger: Awaited<ReturnType<typeof api.ledger>> | null = null;
  let tasks: Awaited<ReturnType<typeof api.agentTasks>> = [];

  try {
    [approvals, worklist, runs, ledger, tasks] = await Promise.all([
      api.approvals(),
      api.worklist(),
      api.payRuns(),
      api.ledger(),
      api.agentTasks(),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : "failed to reach the API";
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const settledCents = runs
    .flatMap((r) => r.items)
    .filter((i) => i.state === "settled")
    .reduce((sum, i) => sum + Number(i.amount.amount) / 10_000, 0);
  const settledRuns = runs.filter((r) => r.status === "settled").length;
  const paidTasks = tasks.filter((t) => t.status === "paid");
  const agentCents = paidTasks.reduce((s, t) => s + t.usdCents, 0);

  return (
    <main className="page">
      {error ? (
        <div className="banner err">
          Could not reach the control plane: {error}. Start it with <code className="mono">npm run api</code>.
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div className="banner warn">
          {pending.length} operation{pending.length === 1 ? "" : "s"} waiting on your approval
          <Link href="/app/approvals" className="x">
            Review →
          </Link>
        </div>
      ) : null}

      <div className="tiles">
        <Tile
          k="Settled (all runs)"
          v={usd(settledCents)}
          sub={`${settledRuns} of ${runs.length} runs fully settled`}
          accent
        />
        <Tile
          k="Awaiting approval"
          v={pending.length}
          sub={pending.length ? "blocked on a human" : "nothing held back"}
        />
        <Tile
          k="Open questions"
          v={worklist.length}
          sub={worklist.length ? "funding unresolved" : "worklist clear"}
        />
        <Tile
          k="Books"
          v={ledger ? (ledger.balanced ? "Balanced" : "Unbalanced") : "—"}
          sub={ledger ? `Σ per currency · ${ledger.entryCount} entries` : "ledger unavailable"}
        />
      </div>

      <div className="split">
        <Panel
          title="Needs a human"
          count={pending.length + worklist.length}
          right={
            <Link href="/app/approvals" className="act act-ghost">
              Approvals
            </Link>
          }
        >
          {pending.length === 0 && worklist.length === 0 ? (
            <div className="empty">Nothing is waiting on a decision.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Why</th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="strong">{a.payeeId}</span>
                        <small className="mono">{a.operationId}</small>
                      </div>
                    </td>
                    <td>
                      <div className="chips">
                        {a.reasonCodes.map((r) => (
                          <span className="chip-tag" key={r}>
                            {label(r)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="num strong">{usd(a.operation.usdCents)}</td>
                    <td className="num">
                      <Link href="/app/approvals" className="act act-dark">
                        Decide
                      </Link>
                    </td>
                  </tr>
                ))}
                {worklist.map((w) => (
                  <tr key={w.requestId}>
                    <td>
                      <div className="cell-stack">
                        <span className="strong">{w.payeeId ?? w.operationId}</span>
                        <small className="mono">{w.requestId}</small>
                      </div>
                    </td>
                    <td>
                      <Status value={w.kind} />
                    </td>
                    <td className="num muted">{w.reason || "—"}</td>
                    <td className="num">
                      <Link href="/app/worklist" className="act act-ghost">
                        Resolve
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel
            title="Books"
            right={
              <Link href="/app/ledger" className="act act-ghost">
                Ledger
              </Link>
            }
          >
            <div className="panel-body">
              {ledger ? (
                <>
                  <div className="banner" style={{ marginBottom: 16 }}>
                    Trial balance {ledger.balanced ? "nets to zero" : "does not balance"} ·{" "}
                    <span className="mono">{short(ledger.attestation, 10, 6)}</span>
                  </div>
                  <dl className="kv">
                    {ledger.trialBalance.map((r) => (
                      <div key={`${r.currency}-${r.account}`} style={{ display: "contents" }}>
                        <dt>{r.account}</dt>
                        <dd>
                          {r.balance}
                          <small className="muted"> {r.currency}</small>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <div className="empty">Ledger unavailable.</div>
              )}
            </div>
          </Panel>

          <Panel title="Agent payouts" count={paidTasks.length}>
            <div className="panel-body">
              <dl className="kv">
                <dt>Paid tasks</dt>
                <dd>{paidTasks.length}</dd>
                <dt>Total to agents</dt>
                <dd>{usd(agentCents)}</dd>
                <dt>With on-chain receipt</dt>
                <dd>{paidTasks.filter((t) => t.receipt).length}</dd>
              </dl>
              <Link href="/app/agents" className="act act-ghost" style={{ marginTop: 16 }}>
                Agent tasks →
              </Link>
            </div>
          </Panel>
        </div>
      </div>

      <Panel
        title="Recent pay runs"
        count={runs.length}
        right={
          <Link href="/app/pay-runs" className="act act-ghost">
            All runs
          </Link>
        }
      >
        {runs.length === 0 ? (
          <div className="empty">No pay runs yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Period</th>
                <th>Source</th>
                <th className="num">Lines</th>
                <th>Status</th>
                <th className="num">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 5).map((r) => (
                <tr key={r.id}>
                  <td className="mono strong">{r.id}</td>
                  <td className="muted">{r.period}</td>
                  <td>
                    <span className="chip-tag">{r.source}</span>
                  </td>
                  <td className="num">{r.items.length}</td>
                  <td>
                    <Status value={r.status} />
                  </td>
                  <td className="num muted">{ago(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </main>
  );
}
