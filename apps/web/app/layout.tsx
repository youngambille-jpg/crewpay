import type { Metadata } from "next";
import { Inter, Comfortaa, Geist_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const comfortaa = Comfortaa({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-comfortaa",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono-google",
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
      <body className={`${inter.variable} ${comfortaa.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
