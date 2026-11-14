import { useCallback, useEffect, useState } from "react";
import { readWallet } from "@/lib/treasury";

/**
 * The name of the window event that says the held wallet's on-chain state
 * changed (a mint, a funding transfer). Every `useWallet` instance reloads on
 * it, so a mint in one surface (the navbar modal) is reflected in another (the
 * overview treasury card) without a shared store.
 */
export const WALLET_CHANGED_EVENT = "crewpay:wallet-changed";

/** Announce that the wallet's balances moved, so every reader reloads. */
export function announceWalletChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WALLET_CHANGED_EVENT));
}

/**
 * The server-held testnet wallet and its live on-chain balances.
 *
 * The wallet is registered at API boot, so this never mints one — it reads the
 * real account and the real balances (gas and mock USDT.e) and exposes a reload
 * so the Fund dialog can show a balance move after a transfer lands.
 */
export default function useWallet() {
  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setWallet(await readWallet());
    } catch (e) {
      setError(e instanceof Error ? e : new Error("could not read the testnet wallet"));
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onChange = () => load();
    window.addEventListener(WALLET_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(WALLET_CHANGED_EVENT, onChange);
  }, [load]);

  return { wallet, loading, error, reload: load };
}
