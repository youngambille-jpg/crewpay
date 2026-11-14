import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/shell/Sidebar";

export const Route = createFileRoute("/_authed/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-5 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-indigo-500/10 blur-[100px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(to_right,rgba(15,23,42,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.04)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]"
      />

      <div className="relative w-full max-w-[404px]">
        <div className="card-surface p-7 text-center sm:p-8">
          <BrandMark className="mx-auto h-11 w-11 rounded-xl text-[19px]" />
          <h1 className="mt-5 text-[28px] font-semibold tracking-[-0.03em]">CrewPay</h1>
          <p className="mx-auto mt-2 max-w-[290px] text-[13px] leading-relaxed text-muted-foreground">
            Programmatic stablecoin payouts with a human in the loop — every decision reproducible.
          </p>
          <Button asChild className="mt-6 h-11 w-full rounded-xl text-[13px] font-medium">
            <Link to="/app">
              Open console
              <ArrowRight className="ml-1.5 h-4 w-4" strokeWidth={2} />
            </Link>
          </Button>
        </div>
        <p className="mt-4 truncate text-center font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Operator console
        </p>
      </div>
    </div>
  );
}