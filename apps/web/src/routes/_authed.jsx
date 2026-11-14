import { createFileRoute, Outlet } from "@tanstack/react-router";

// Pathless layout route. There is no login wall: this console sits behind the
// operator's own deployment, and API authorization is the server-held bearer
// token attached by the proxy server functions — never a browser session.
export const Route = createFileRoute("/_authed")({
  component: () => <Outlet />,
});
