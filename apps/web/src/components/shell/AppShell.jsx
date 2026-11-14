import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import Sidebar, { BrandMark } from "@/components/shell/Sidebar";
import { navTitle } from "@/components/shell/nav";

export default function AppShell({ children }) {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden lg:block">
        <Sidebar pathname={pathname} />
      </aside>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b hairline bg-background/85 px-4 backdrop-blur-md lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-2.5 rounded-lg py-1 pr-2 text-left"
          >
            <BrandMark className="h-7 w-7 rounded-lg text-[13px]" />
            <span className="leading-tight">
              <span className="block font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                CrewPay
              </span>
              <span className="block text-[13px] font-semibold">{navTitle(pathname)}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            className="flex h-9 w-9 items-center justify-center rounded-xl border hairline bg-white text-foreground shadow-sm"
          >
            <Menu className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>

        <main className="mx-auto w-full max-w-[1280px] px-4 pb-20 pt-5 sm:px-6 lg:px-8 lg:pt-9">{children}</main>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[268px] border-r hairline p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar pathname={pathname} onNavigate={() => setOpen(false)} className="w-full border-r-0" />
        </SheetContent>
      </Sheet>
    </div>
  );
}