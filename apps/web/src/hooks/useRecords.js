import { useCallback, useEffect, useState } from "react";
import { apiList } from "@/api/server-calls";
import {
  toUiApproval,
  toUiInvoice,
  toUiPayee,
  toUiPayRun,
  toUiPayRunLine,
  toUiWorklistItem,
} from "@/api/crewpay";

/**
 * Entity reads against the CrewPay API. Each entity names its own endpoint and
 * its own mapping; anything not listed throws an explicit not-wired error rather
 * than returning a plausible empty list, so an unwired screen fails loudly
 * instead of looking empty.
 */
const READERS = {
  Payee: {
    path: "/v1/payees",
    map: (rows) => rows.map(toUiPayee).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  },
  PayRun: {
    path: "/v1/pay-runs",
    map: (rows) => rows.map(toUiPayRun),
  },
  Approval: {
    path: "/v1/approvals",
    map: async (rows) => {
      const payees = await apiList("/v1/payees");
      const names = new Map(payees.map((p) => [p.id, p.displayName]));
      return rows.map((row) => toUiApproval(row, names));
    },
  },
  WorklistItem: {
    path: "/v1/custody/requests",
    map: (rows) => rows.map(toUiWorklistItem),
  },
  Invoice: {
    path: "/v1/invoices",
    map: (rows) => rows.map(toUiInvoice),
  },
  PayRunLine: {
    path: "/v1/operations",
    // Lines carry a payee id; the directory gives the human name. Fetched here
    // rather than left to each screen so every line renders the same way.
    map: async (rows) => {
      const payees = await apiList("/v1/payees");
      const names = new Map(payees.map((p) => [p.id, p.displayName]));
      return rows.map((row) => toUiPayRunLine(row, names));
    },
  },
};

export default function useRecords(entity, _query = {}, _options = {}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Unwired entities throw during render so the route boundary names the gap.
  // An empty table would claim the org has no data; this claims nothing.
  const reader = READERS[entity];
  if (!reader) throw new Error(`${entity} is not wired to the CrewPay API yet`);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await apiList(reader.path);
      setItems(await reader.map(rows));
    } catch (e) {
      setError(e instanceof Error ? e : new Error("could not load records"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [reader.path]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, loading, error, reload: load };
}
