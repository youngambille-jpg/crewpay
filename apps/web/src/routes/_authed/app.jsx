import { createFileRoute, Outlet } from "@tanstack/react-router";
import AppShell from "@/components/shell/AppShell";

export const Route = createFileRoute("/_authed/app")({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});