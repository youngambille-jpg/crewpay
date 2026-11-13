import type { ReactNode } from "react";
import Sidebar from "@/components/app/Sidebar";
import { api } from "@/lib/api";
import "../app.css";

/**
 * The app shell. Counts for the sidebar badges are fetched here so a pending
 * approval is visible from any screen, not only the approvals page.
 *
 * Every fetch is guarded: if the API is down the shell still renders and each
 * page shows its own error, rather than the whole app failing to load.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  let counts: Partial<Record<string, number>> = {};
  let rail = "unknown";

  try {
    const [approvals, worklist, health] = await Promise.all([
      api.approvals(),
      api.worklist(),
      api.health(),
    ]);
    rail = health.rail;
    counts = {
      "/app/approvals": approvals.filter((a) => a.status === "pending").length,
      "/app/worklist": worklist.length,
    };
  } catch {
    // Leave counts empty; the pages surface the connection problem.
  }

  return (
    <div className="app">
      <Sidebar counts={counts} />
      <div className="main">
        <div className="topbar">
          <span className="crumb">Acme Inc</span>
          <span className="rail-pill">
            <span className="live" />
            rail: {rail}
          </span>
          <div className="topbar-right">
            <span className="avatar">O</span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
