import type { Metadata } from "next";
import { Inter, Caveat } from "next/font/google";
import "./globals.css";

/* Open Runde is not on Google Fonts. Inter is the first-listed substitute in
   the style reference and was also detected on the source page, so it carries
   both display and body here. Caveat is the signature element, used only for
   handwritten attributions and annotations. */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const caveat = Caveat({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-caveat",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CrewPay — One guarded pay run for your whole workforce",
  description:
    "CrewPay runs global pay runs on stablecoin rails under deterministic policy guardrails. Pay contractors, vendors and AI agents — and book every settlement to a double-entry ledger.",
  openGraph: {
    title: "CrewPay — One guarded pay run for your whole workforce",
    description:
      "Policy-guarded stablecoin payroll for contractors, vendors and AI agents. You set the rules once; the agent can't exceed them.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${caveat.variable}`}>{children}</body>
    </html>
  );
}
