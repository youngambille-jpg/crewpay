import Nav from "@/components/Nav";
import PaperStack from "@/components/PaperStack";
import { Check, Plus } from "@/components/Icons";

const CAPABILITIES = [
  {
    num: "01",
    title: "Guarded pay runs",
    body: "Upload a CSV or call the API. Every line becomes an Operation, evaluated by a deterministic, versioned policy engine before a single unit moves.",
    points: ["Per-transaction and daily caps", "Payee allowlists", "Approval thresholds"],
  },
  {
    num: "02",
    title: "Cross-chain settlement",
    body: "Payees get paid on their own chain. A base-USDC treasury settles to a NEAR recipient through NEAR Intents — no bridges for you to babysit.",
    points: ["NEAR Intents 1Click", "Live asset registry, drift-guarded", "Deposit proof on every settle"],
  },
  {
    num: "03",
    title: "Agent payees",
    body: "An AI agent is a payee like any other. A task becomes an ordinary Operation, so per-kind caps and approvals apply identically.",
    points: ["Paid per completed task", "x402 charge", "Same policy gate as payroll"],
  },
  {
    num: "04",
    title: "Books that reconcile",
    body: "Every settlement writes a balanced double-entry journal entry linked to on-chain evidence. The endpoint refuses to report books that don't balance.",
    points: ["Trial balance nets to zero", "Content-hash attestation", "1099-style roll-up by payee"],
  },
];

const FLOWS = [
  {
    title: "Pay run",
    steps: [
      "Source: payroll CSV, API call, or a paid invoice",
      "Each line becomes an Operation",
      "Policy evaluates — allow, hold, or deny",
      "Allowed lines settle through a funded rail",
      "A balanced journal entry is written",
    ],
  },
  {
    title: "Invoice → payout",
    steps: [
      "Issue a hosted PingPay checkout",
      "Customer pays in fiat or crypto",
      "Signed webhook is verified and deduped",
      "Session is read back — the webhook is a claim, the session is truth",
      "The same policy path opens the pay run",
    ],
  },
  {
    title: "Agent task",
    steps: [
      "Task becomes an Operation",
      "Same deterministic policy gate",
      "x402 quote → deposit → settle",
      "One operation token on every retry",
      "Receipt and journal entry on success",
    ],
  },
];

const WHY = [
  {
    title: "The agent proposes, policy disposes",
    body: "There is no LLM in the money path. Policy is deterministic and versioned, so a decision can be reproduced and audited — not explained after the fact.",
  },
  {
    title: "Misbehavior is structurally impossible",
    body: "Competitors ask you to trust the agent or the operator. Here the guardrail is the architecture: an operation that violates a rule cannot be signed.",
  },
  {
    title: "Unknown funding stops, it never retries",
    body: "When funding state is unknown we stop and surface it. We would rather hold a pay run for a human than risk moving the same money twice.",
  },
];

const PROOF = [
  {
    k: "Ledger",
    title: "Balanced by construction",
    body: "Every operation produces a signed receipt and a double-entry line. The books are correct by construction and auditable from chain.",
    code: "GET /v1/ledger → Σ = 0",
  },
  {
    k: "Policy",
    title: "Compiled and drift-checked",
    body: "The same rules that gate a run compile to an OutLayer manifest. We diff the compiled manifest against the TEE's effective policy and report drift.",
    code: "GET /v1/manifest → drift: none",
  },
  {
    k: "Custody",
    title: "Non-custodial by default",
    body: "CrewPay never holds your funds. Signing happens inside a TEE; this service holds a wallet API key, never a private key.",
    code: "signer: TEE · keys never leave",
  },
  {
    k: "Reconciliation",
    title: "A deposit is not a payment",
    body: "A deposit landing only means funds reached the rail. We follow it to the rail's own status and book a settlement only when the payee is actually paid.",
    code: "POST /v1/custody/requests/:id/resolve",
  },
];

const PRICING = [
  {
    name: "Starter",
    price: "$0",
    unit: "up to 10 payees",
    featured: false,
    items: [
      "Unlimited pay runs",
      "Policy engine + approvals inbox",
      "Double-entry ledger export",
      "Stablecoin settlement via NEAR Intents",
    ],
    cta: "Start free",
  },
  {
    name: "Growth",
    price: "0.5%",
    unit: "of settled volume",
    featured: true,
    items: [
      "Everything in Starter",
      "Agent payees (x402)",
      "PingPay fiat collection",
      "Manifest drift monitoring",
      "1099-style roll-up",
    ],
    cta: "Book a pay run",
  },
  {
    name: "Scale",
    price: "Custom",
    unit: "annual, invoice-based",
    featured: false,
    items: [
      "Everything in Growth",
      "Self-hosted control plane",
      "Postgres persistence + SSO",
      "Dedicated onboarding",
    ],
    cta: "Talk to us",
  },
];

const FAQ = [
  {
    q: "Does CrewPay hold my money?",
    a: "No. CrewPay is non-custodial by design. Funds sit with your own provider or in your NEAR Intents balance, and signing happens inside a TEE. This service holds a wallet API key — never a private key.",
  },
  {
    q: "Do you pay out in local currency?",
    a: "No. We settle in stablecoins on the payee's own chain, and PingPay is used for fiat collection — getting paid by your customers. Local-currency payout is not something we claim.",
  },
  {
    q: "Can I really pay an AI agent with this?",
    a: "Yes. An agent is a payee like any other, paid per completed task over x402. The important part is that a task becomes an ordinary Operation, so the same caps and approval thresholds apply — an agent gets no special path around policy.",
  },
  {
    q: "What happens when a payment's funding state is unknown?",
    a: "We stop. The operation goes to a review worklist instead of retrying, because a retry could move the same money twice. A human resolves it by re-reading the true state; the resolver never re-submits.",
  },
  {
    q: "Are you a licensed payroll provider?",
    a: "No. We are not an employer of record and hold no money-transmitter licenses. We are the control and books layer above rails. If you need EOR or in-country compliance, that is a different product.",
  },
  {
    q: "How does pricing work?",
    a: "Starter is free up to 10 payees. Growth is 0.5% of settled volume. Scale is annual and invoice-based. You never pay for denied operations — nothing moved, so nothing is charged.",
  },
];

export default function Home() {
  return (
    <>
      <span id="top" />
      <Nav />

      <main>
        {/* ============================ hero ============================ */}
        <section className="hero">
          <div className="wrap hero-inner">
            <span className="eyebrow">
              Stablecoin payroll · NEAR Intents · x402
            </span>

            <h1 className="display">
              One guarded pay run for your whole workforce
            </h1>

            <p className="hero-sub">
              Contractors, vendors and AI agents, paid per task on stablecoins —
              on their own chain. You set the rules once; the agent can&apos;t
              exceed them.
            </p>

            <div className="hero-actions">
              <a className="btn btn-fill" href="/app/connect">
                Try the live demo
              </a>
              <a className="btn btn-outline" href="#flows">
                See how it works
              </a>
            </div>

            <div className="rates">
              <span className="rate">
                <span className="tick">
                  <Check size={11} color="#ffffff" />
                </span>
                Policy checks <b>every line</b>
              </span>
              <span className="rate">
                <span className="tick">
                  <Check size={11} color="#ffffff" />
                </span>
                Books <b>always balance</b>
              </span>
              <span className="rate">
                <span className="tick">
                  <Check size={11} color="#ffffff" />
                </span>
                Non-custodial <b>by design</b>
              </span>
            </div>

            <PaperStack />
          </div>
        </section>

        {/* ============================ stats ============================ */}
        <section className="section" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="stats">
              <div className="stat">
                <b>0</b>
                <span>LLMs in the money path</span>
              </div>
              <div className="stat">
                <b>Σ = 0</b>
                <span>Trial balance, enforced</span>
              </div>
              <div className="stat">
                <b>4</b>
                <span>Settlement outcomes, all recorded</span>
              </div>
              <div className="stat">
                <b>100%</b>
                <span>Settlements with on-chain proof</span>
              </div>
            </div>
          </div>
        </section>

        {/* ============================ large panel ============================ */}
        <section className="section" id="product">
          <div className="wrap">
            <div className="panel">
              <div>
                <span className="eyebrow">The control layer</span>
                <h2 style={{ marginTop: 16 }}>
                  We designed a pay run that cannot overspend itself
                </h2>
                <p className="body">
                  The rails are a commodity. The trust-and-books layer is the
                  product: a deterministic gate in front of the money, and a
                  double-entry ledger behind it. Signing happens in a TEE, and
                  CrewPay never holds your funds.
                </p>
              </div>

              <div className="panel-right">
                <div className="rate-row">
                  <span className="l">
                    <span className="ic" style={{ background: "#6c56fc" }}>
                      N
                    </span>
                    NEAR Intents
                  </span>
                  <span className="v">
                    Cross-chain
                    <small>settlement</small>
                  </span>
                </div>
                <div className="rate-row">
                  <span className="l">
                    <span className="ic" style={{ background: "#0098f2" }}>
                      P
                    </span>
                    PingPay
                  </span>
                  <span className="v">
                    Fiat + x402
                    <small>collection</small>
                  </span>
                </div>
                <div className="rate-row">
                  <span className="l">
                    <span className="ic" style={{ background: "#0d111b" }}>
                      T
                    </span>
                    OutLayer TEE
                  </span>
                  <span className="v">
                    Keys stay
                    <small>in the TEE</small>
                  </span>
                </div>
                <div className="rate-row">
                  <span className="l">
                    <span className="ic" style={{ background: "#5d9c06" }}>
                      L
                    </span>
                    CrewPay ledger
                  </span>
                  <span className="v">
                    Σ = 0
                    <small>enforced</small>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================ capabilities ============================ */}
        <section className="section band">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">Capabilities</span>
              <h2 className="display">What we bring to the table</h2>
              <p className="sub">
                Four things, all of them load-bearing. Everything below is
                implemented and tested — the money logic runs end to end with no
                network and no credentials.
              </p>
            </div>

            <div className="grid-2">
              {CAPABILITIES.map((c) => (
                <div className="card" key={c.num}>
                  <span className="num">{c.num}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  <ul>
                    {c.points.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ flows ============================ */}
        <section className="section" id="flows">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">Three money flows</span>
              <h2 className="display">One policy path, three ways in</h2>
              <p className="sub">
                Payroll, an invoice you collected, and a task an agent completed
                all converge on the same gate. That is the whole design: one
                place where money is allowed, one place where it is recorded.
              </p>
            </div>

            <div className="grid-3">
              {FLOWS.map((f) => (
                <div className="flow" key={f.title}>
                  <h3>{f.title}</h3>
                  <ol>
                    {f.steps.map((s, i) => (
                      <li key={s}>
                        <b>{i + 1}</b>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ why ============================ */}
        <section className="section band" id="why">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">Why teams stick with us</span>
              <h2 className="display">Guardrails you can point at</h2>
            </div>

            <div className="why">
              {WHY.map((w) => (
                <div className="why-item" key={w.title}>
                  <b>{w.title}</b>
                  <p>{w.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ proof ============================ */}
        <section className="section">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">Stuff we&apos;re proud of</span>
              <h2 className="display">Proof, not promises</h2>
              <p className="sub">
                Each of these is an endpoint you can call, not a claim on a
                slide.
              </p>
            </div>

            <div className="proof">
              {PROOF.map((p) => (
                <div className="proof-card" key={p.k}>
                  <span className="k">{p.k}</span>
                  <b>{p.title}</b>
                  <p>{p.body}</p>
                  <code>{p.code}</code>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ pricing ============================ */}
        <section className="section band" id="pricing">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">Pricing</span>
              <h2 className="display">Invest in getting paid right</h2>
              <p className="sub">
                You never pay for a denied operation. Nothing moved, so nothing
                is charged.
              </p>
            </div>

            <div className="grid-3">
              {PRICING.map((p) => (
                <div
                  className={`price-card${p.featured ? " featured" : ""}`}
                  key={p.name}
                >
                  <span className="price-name">{p.name}</span>
                  <div className="amount">
                    {p.price}
                    <small>{p.unit}</small>
                  </div>
                  <ul>
                    {p.items.map((i) => (
                      <li key={i}>
                        <Check
                          size={15}
                          color={p.featured ? "#0098f2" : "#0098f2"}
                        />
                        {i}
                      </li>
                    ))}
                  </ul>
                  <a
                    className={`btn ${p.featured ? "btn-ghost" : "btn-fill"}`}
                    href="#cta"
                    style={{ marginTop: "auto" }}
                  >
                    {p.cta}
                  </a>
                </div>
              ))}
            </div>

            <p className="price-note">
              Pricing shown is indicative for design review, not a published rate
              card.
            </p>
          </div>
        </section>

        {/* ============================ faq ============================ */}
        <section className="section" id="faq">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">Let&apos;s clear things up</span>
              <h2 className="display">Questions, answered plainly</h2>
            </div>

            <div className="faq">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>
                    {f.q}
                    <span className="ic">
                      <Plus size={18} />
                    </span>
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ cta ============================ */}
        <section className="section" id="cta">
          <div className="wrap">
            <div className="cta">
              <span className="eyebrow">Let&apos;s make something good</span>
              <h2>Run your next pay run on CrewPay</h2>
              <p>
                Send us your contributor list and your rules. We&apos;ll run the
                first pay run with you and show you the ledger it produces.
              </p>
              <div className="hero-actions">
                <a className="btn btn-fill" href="/app/connect">
                  Open the demo
                </a>
                <a className="btn btn-outline" href="mailto:hello@crewpay.xyz">
                  Book a pay run
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ============================ footer ============================ */}
      <footer className="footer">
        <div className="wrap">
          <div className="footer-top">
            <div className="footer-about">
              <span className="brand">
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 888,
                    background: "#0d111b",
                    display: "inline-block",
                  }}
                  aria-hidden
                />
                CrewPay
              </span>
              <p>
                Payroll and payouts for the agentic workforce. A policy-guarded
                agent runs global pay runs on stablecoin rails.
              </p>
            </div>

            <div className="footer-cols">
              <div className="footer-col">
                <b>Product</b>
                <a href="#product">Capabilities</a>
                <a href="#flows">Flows</a>
                <a href="#faq">Proof</a>
                <a href="#pricing">Pricing</a>
              </div>
              <div className="footer-col">
                <b>Rails</b>
                <a href="#product">NEAR Intents</a>
                <a href="#product">PingPay</a>
                <a href="#product">OutLayer TEE</a>
                <a href="#faq">FAQ</a>
              </div>
              <div className="footer-col">
                <b>Contact</b>
                <a href="mailto:hello@crewpay.xyz">hello@crewpay.xyz</a>
                <a href="#cta">Book a pay run</a>
              </div>
            </div>
          </div>

          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} CrewPay</span>
            <span>
              Non-custodial · not an employer of record · no license claims
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
