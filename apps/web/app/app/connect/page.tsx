import ConnectWallet from "@/components/app/ConnectWallet";
import { api, type ConnectState, type LiveHealth } from "@/lib/api";

/**
 * Connect: provision a real custody wallet and see the live state of the three
 * services a payout actually uses.
 *
 * Both reads are real. If the API is unreachable the page still renders with a
 * degraded health strip rather than failing — a connection screen that cannot
 * load is worse than one that admits it cannot reach the control plane.
 */
export default async function ConnectPage() {
  let state: ConnectState = { connected: false };
  let health: LiveHealth = {
    mode: "demo",
    checkedAt: new Date().toISOString(),
    services: [],
    allUp: false,
  };

  try {
    [state, health] = await Promise.all([api.connectState(), api.liveHealth()]);
  } catch {
    // Leave both at their defaults; the strip will read as degraded.
  }

  return (
    <main className="page">
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Connect</h1>
        <p className="page-note" style={{ marginTop: 4 }}>
          CrewPay never holds a private key. Signing happens inside a hardware enclave; this service
          holds only an API key that can request signatures.
        </p>
      </div>
      <ConnectWallet initial={state} health={health} />
    </main>
  );
}
