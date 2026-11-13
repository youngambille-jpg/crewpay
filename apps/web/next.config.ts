import type { NextConfig } from "next";

/**
 * The dashboard talks to the control plane through this origin: `/api/*` is
 * proxied to the API process. Proxying rather than calling the API directly
 * keeps the browser same-origin, so there is one public URL and no CORS in the
 * path. API_ORIGIN points at the API process; the default matches `npm run api`.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/:path*` }];
  },
};

export default nextConfig;
