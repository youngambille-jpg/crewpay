import Link from "next/link";

const LINKS = [
  { href: "#capabilities", label: "Capabilities" },
  { href: "#flows", label: "Flows" },
  { href: "#why", label: "Why CrewPay" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav() {
  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <Link href="/" className="brand" aria-label="CrewPay home">
          <span className="brand-mark" aria-hidden />
          CrewPay
        </Link>

        <nav className="nav-links" aria-label="Primary">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>

        <a className="btn btn-primary btn-sm" href="#cta">
          Book a pay run
        </a>
      </div>
    </header>
  );
}
