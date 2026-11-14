import { Logo } from "./Icons";

const LINKS = [
  { href: "#product", label: "Product" },
  { href: "#flows", label: "Flows" },
  { href: "#why", label: "Why CrewPay" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav() {
  return (
    <div className="nav-shell">
      <header className="nav">
        <a href="#top" className="brand" aria-label="CrewPay home">
          <Logo />
          CrewPay
        </a>

        <nav className="nav-links" aria-label="Primary">
          {LINKS.map((l) => (
            <a key={l.href} className="nav-link" href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>

        <div className="nav-cta">
          <a className="nav-login" href="/app">
            Dashboard
          </a>
          <a className="btn btn-fill btn-sm" href="/app/connect">
            Try the demo
          </a>
        </div>
      </header>
    </div>
  );
}
