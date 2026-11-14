import type { ChainAsset, UsdCents } from "./money.ts";

/**
 * Ping's checkout-session status, exactly as the API emits it. Do not widen
 * this set: inventing a `paid` synonym hides the fact that a session can be
 * `CANCELLED`, which is a terminal non-payment and must not be treated as one.
 */
export type PingCheckoutStatus =
  | "CREATED"
  | "PENDING"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED";

/** Ping's payment status. A payment is final only at SUCCESS or FAILED. */
export type PingPaymentStatus = "PENDING" | "SUCCESS" | "FAILED";

export type InvoiceStatus =
  | "open"
  | "pending"
  | "paid"
  | "expired"
  | "cancelled"
  | "refunded"
  | "failed";

/** One line on an invoice. `amount` is USD cents, like the invoice total. */
export interface InvoiceLineItem {
  readonly description: string;
  readonly quantity: number;
  readonly unitAmount: UsdCents;
  /** `quantity * unitAmount`, stored so a line is never re-derived on display. */
  readonly amount: UsdCents;
}

export function lineItemAmount(quantity: number, unitAmount: UsdCents): UsdCents {
  return Math.round(quantity * unitAmount);
}

/**
 * An invoice issued to a customer, backed by a Ping hosted checkout session.
 *
 * The invoice is the thing the merchant reconciles against; the checkout
 * session is how the customer pays it. They are kept separate because a session
 * can be re-created (it expires) while the invoice stays the same obligation,
 * and because only the session id is needed to ask Ping for the truth.
 */
export interface Invoice {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly amount: UsdCents;
  /** Optional itemised breakdown. When absent the invoice is a single amount. */
  readonly lineItems?: readonly InvoiceLineItem[];
  /** ISO date the customer is asked to pay by. Not a hard cutoff — Ping owns expiry. */
  readonly dueDate?: string;
  /** What the customer pays with, and what Ping settles to us. */
  readonly settlementAsset: ChainAsset;
  readonly status: InvoiceStatus;
  /** Ping's hosted checkout session id. The handle for reconciliation. */
  readonly checkoutSessionId: string;
  /**
   * The redirect target for the customer. Opaque: treat it exactly as Ping
   * returned it and never construct it, per Ping's own note.
   */
  readonly checkoutUrl: string;
  readonly createdAt: string;
  /** When Ping says the session stops being payable. */
  readonly expiresAt?: string;
  /** Set when the invoice was created from a pay run, so the two correlate. */
  readonly payRunId?: string;
  /** Ping's payment id once one exists. */
  readonly paymentId?: string;
  /**
   * Chain transaction(s) that settled the payment, once Ping reports them.
   * Kept so a bookkeeper can trace a paid invoice to a real transaction rather
   * than taking the status on trust.
   */
  readonly txHashes?: readonly string[];
  readonly paidAt?: string;
}

/**
 * Ping's webhook envelope. `resourceId` is the session or payment the event is
 * about, and it is the only field the handler should trust for identity — the
 * `data` bag is free-form and Ping documents it as "anything".
 */
export interface PingWebhookEvent {
  readonly id: string;
  readonly type: PingWebhookEventType;
  readonly resourceId: string;
  readonly data?: Record<string, unknown>;
  readonly createdAt?: string;
}

export type PingWebhookEventType =
  | "payment.pending"
  | "payment.success"
  | "payment.failed"
  | "checkout.session.completed"
  | "checkout.session.expired";

/**
 * Which Ping session statuses mean the customer paid. `COMPLETED` is the only
 * one: `PENDING` is not final, and `EXPIRED`/`CANCELLED` are terminal
 * non-payments that must never release a pay run.
 */
export function invoiceStatusFor(session: PingCheckoutStatus): InvoiceStatus {
  switch (session) {
    case "COMPLETED":
      return "paid";
    case "EXPIRED":
      return "expired";
    case "CANCELLED":
      return "cancelled";
    case "CREATED":
    case "PENDING":
      return "open";
    default:
      return "open";
  }
}

/**
 * Which Ping *payment* statuses map to which invoice state. A payment that is
 * merely `PENDING` moves the invoice to `pending` — money is on its way but has
 * not cleared — which is why it is distinct from `open` (nothing sent yet) and
 * from `paid` (cleared). `FAILED` is terminal non-payment.
 */
export function invoiceStatusForPayment(payment: PingPaymentStatus | string): InvoiceStatus {
  switch (payment) {
    case "SUCCESS":
      return "paid";
    case "PENDING":
      return "pending";
    case "FAILED":
      return "failed";
    default:
      return "open";
  }
}
