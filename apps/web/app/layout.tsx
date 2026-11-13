import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Caveat } from "next/font/google";
import "./globals.css";

/* Open Runde is not on Google Fonts. Plus Jakarta Sans is the closest
   geometric, slightly-monoLinear match with real character at display sizes —
   a better fit than a neutral UI face. Caveat stays the handwritten signature,
   used only for annotations. */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jakarta",
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
      <body className={`${jakarta.variable} ${caveat.variable}`}>{children}</body>
    </html>
  );
}
