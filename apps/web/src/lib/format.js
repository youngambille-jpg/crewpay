const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function money(cents) {
  return USD.format((Number(cents) || 0) / 100);
}

export function moneyWhole(cents) {
  return USD_WHOLE.format((Number(cents) || 0) / 100);
}

export function moneyCompact(cents) {
  const value = (Number(cents) || 0) / 100;
  if (Math.abs(value) < 10000) return USD_WHOLE.format(value);
  return USD_COMPACT.format(value);
}

// "$1,250.50" / "1250.5" / "1,250" -> 125050 cents
export function toCents(input) {
  const clean = String(input ?? "").replace(/[^0-9.]/g, "");
  if (!clean) return 0;
  return Math.round(Number.parseFloat(clean) * 100) || 0;
}

export function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export function shortHex(value, lead = 6, tail = 4) {
  if (!value) return "—";
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function initials(name) {
  if (!name) return "OP";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function ref(prefix, seed) {
  const stamp = String(Math.floor(Date.now() / 1000)).slice(-4);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `${prefix}-${stamp}${rand}`;
}

/**
 * Base units (a decimal string, as the API sends bigints) to a trimmed decimal
 * string. Never `Number()`-ed: an on-chain balance can exceed the float-safe
 * range, and truncating it would misreport the balance. `decimals` is the
 * asset's own scale (NEAR 24, USDT.e 6).
 */
export function fromBaseUnits(value, decimals) {
  if (value == null || value === "") return "0";
  const negative = String(value).startsWith("-");
  const digits = String(value).replace("-", "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Base units to a short display string, e.g. NEAR gas at 24 decimals. */
export function formatBaseUnits(value, decimals, { maxFractionDigits = 4 } = {}) {
  const [whole, frac = ""] = fromBaseUnits(value, decimals).split(".");
  if (!frac) return whole;
  const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** True when a base-unit string is a positive amount. */
export function hasFunds(value) {
  if (value == null) return false;
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

/**
 * A decimal string ("10", "10.5") to base units (a bigint string) at the given
 * scale. String math only: `Number()` would round a large amount, and the API
 * wants an exact integer. Digits past the scale are truncated, not rounded.
 */
export function toBaseUnits(input, decimals) {
  const clean = String(input ?? "").replace(/[^0-9.]/g, "");
  if (!clean) return "0";
  const [whole = "", frac = ""] = clean.split(".");
  const scaled = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(scaled || "0")).toString();
}