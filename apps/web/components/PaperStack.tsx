import { Check } from "./Icons";

/* The layered paper stack: three invoice/pay-run documents offset and rotated
   to read as paper on a desk. Data mirrors what `npm run demo` actually
   produces — a contractor settles, a vendor sits in approval, an agent is
   paid per task. Not invented for the page. */

function Sheet({
  label,
  no,
  status,
  statusClass,
  from,
  fromDot,
  to,
  toDot,
  rows,
  total,
  totalLabel,
}: {
  label: string;
  no: string;
  status: string;
  statusClass: string;
  from: string;
  fromDot: string;
  to: string;
  toDot: string;
  rows: { item: string; amount: string }[];
  total: string;
  totalLabel: string;
}) {
  return (
    <>
      <div className="paper-head">
        <div>
          <div className="paper-label">Pay run</div>
          <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.03em" }}>
            {no}
          </div>
        </div>
        <span className={`chip ${statusClass}`}>{status}</span>
      </div>

      <div className="paper-parties">
        <div className="party">
          <div className="party-top">
            <span className={`party-dot ${fromDot}`}>{from.charAt(0)}</span>
            <span className="party-name">{from}</span>
          </div>
          <span className="party-meta">Funding · base USDC</span>
        </div>
        <div className="party">
          <div className="party-top">
            <span className={`party-dot ${toDot}`}>{to.charAt(0)}</span>
            <span className="party-name">{to}</span>
          </div>
          <span className="party-meta">{label}</span>
        </div>
      </div>

      <table className="paper-table">
        <thead>
          <tr>
            <th>Line</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.item}>
              <td>{r.item}</td>
              <td>{r.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="paper-total">
        <span>{totalLabel}</span>
        <b>{total}</b>
      </div>
    </>
  );
}

export default function PaperStack() {
  return (
    <div className="paper-stage" aria-label="Example pay run documents">
      {/* back-left sheet */}
      <div className="paper paper-left" aria-hidden>
        <div className="paper-head">
          <div>
            <div className="paper-label">Invoice</div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>
              #1042
            </div>
          </div>
          <span className="chip chip-pending">Approval</span>
        </div>
        <div className="party" style={{ marginTop: 16 }}>
          <div className="party-top">
            <span className="party-dot dot-leaf">A</span>
            <span className="party-name" style={{ fontSize: 16 }}>
              Acme Co
            </span>
          </div>
          <span className="party-meta">Over approval threshold</span>
        </div>
        <div className="paper-total">
          <span>Held</span>
          <b style={{ fontSize: 18 }}>12,400.00</b>
        </div>
      </div>

      {/* back-right sheet */}
      <div className="paper paper-right" aria-hidden>
        <div className="paper-head">
          <div>
            <div className="paper-label">Agent task</div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.03em" }}>
              research-bot
            </div>
          </div>
          <span className="chip chip-paid">x402 paid</span>
        </div>
        <div className="party" style={{ marginTop: 16 }}>
          <div className="party-top">
            <span className="party-dot dot-iris">R</span>
            <span className="party-name" style={{ fontSize: 16 }}>
              Paid per task
            </span>
          </div>
          <span className="party-meta">Same policy gate as payroll</span>
        </div>
        <div className="paper-total">
          <span>Settled</span>
          <b style={{ fontSize: 18 }}>40.00</b>
        </div>
      </div>

      {/* front sheet */}
      <div className="paper paper-main">
        <Sheet
          label="Contractor · near"
          no="Run 2026-11"
          status="Settled"
          statusClass="chip-paid"
          from="Treasury"
          fromDot="dot-iris"
          to="0x7a…31f2"
          toDot="dot-leaf"
          rows={[
            { item: "Contractor · 0x7a…31f2", amount: "1,500.00" },
            { item: "Vendor · invoices@acme.co", amount: "12,400.00" },
            { item: "Agent · research-bot", amount: "40.00" },
            { item: "Contractor · 0x9c…04ab", amount: "820.00" },
          ]}
          total="14,760.00 USDC"
          totalLabel="Pay run total"
        />
      </div>

      <div className="note">
        <Check size={20} color="#0098f2" />
        books balance — every line
      </div>
    </div>
  );
}
