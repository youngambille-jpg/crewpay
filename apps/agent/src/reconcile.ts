import type { Operation } from "@crewpay/domain";
import { paymentSettled, type JournalEntry } from "@crewpay/ledger";
import type { Quote, SettlementRail, SettlementResult } from "@crewpay/rails";
import type { FundingRequestState, Signer } from "@crewpay/signer";

/**
 * What resolving one funding request concluded.
 *
 * `settled` is the only variant that touches the books, and it means the payee
 * was actually paid — not merely that the deposit left. `open` means the
 * question is still unanswered and the request must stay on the worklist.
 */
export type ResolveOutcome =
  | {
      readonly kind: "settled";
      readonly journal: JournalEntry;
      readonly deposit: FundingRequestState;
      readonly settlement: SettlementResult;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly deposit: FundingRequestState;
      readonly settlement?: SettlementResult;
    }
  | { readonly kind: "open"; readonly reason: string; readonly deposit: FundingRequestState };

export interface ResolveFundingArgs {
  /** Must expose `reconcile`; without it there is nothing to re-read. */
  readonly signer: Signer;
  /** The rail to ask whether the payee was paid. Absent means we cannot know. */
  readonly rail?: SettlementRail;
  /**
   * Which service settles this deposit. An agent task settles through the x402
   * facilitator, for which this module has no read-only status call, so it stays
   * open rather than being answered from the wrong service.
   */
  readonly settlesVia?: "rail" | "agentpay";
  readonly requestId: string;
  /** The operation this deposit funded; supplies the currency and org. */
  readonly operation?: Operation;
  /** The quote whose deposit address the rail answers settlement status for. */
  readonly railQuote?: Quote;
}

/**
 * Close the loop on a funding request whose outcome was unresolved.
 *
 * The trap this avoids: a funding `success` means the *deposit reached the
 * rail*, not that the payee was paid. In the pay run an unresolved funding
 * returns before the rail is ever submitted, so a deposit can land and settle
 * with nobody watching. Booking a settlement on the deposit alone would invent
 * money movement — so a confirmed deposit is only the point at which we start
 * asking the rail whether the payee actually got paid, and the books are
 * written only when the rail says `settled`.
 *
 * Every step here is a read. It never re-submits, never re-funds, and never
 * retries a request whose funds may already have moved.
 */
export async function resolveFunding(args: ResolveFundingArgs): Promise<ResolveOutcome> {
  if (!args.signer.reconcile) {
    throw new Error("the configured signer cannot re-read a funding request");
  }
  const deposit = await args.signer.reconcile(args.requestId);

  // Funds provably back (`refunded`) or provably never sent (`rejected`): the
  // question is answered and the money is accounted for, so the request can
  // leave the worklist.
  if (deposit.status === "refunded" || deposit.status === "rejected") {
    return { kind: "failed", reason: deposit.reason ?? `deposit ${deposit.status}`, deposit };
  }

  // A bare `failed` is NOT in that class. The service only proves funds did not
  // move when it says the request never executed or was never submitted; absent
  // that, a failure may still have moved the deposit. Closing it here would drop
  // the one handle that can find the money, so it stays open for a human.
  if (deposit.status === "failed") {
    return {
      kind: "open",
      reason:
        deposit.reason ??
        "funding failed; the origin funds may have moved — confirm before retrying",
      deposit,
    };
  }

  // `needs_review` is terminal but says the fund state is UNKNOWN, which is the
  // opposite of an answer. So does anything still in flight, including the
  // multisig states, which move only when a human votes.
  if (deposit.status !== "success") {
    return {
      kind: "open",
      reason:
        deposit.status === "needs_review"
          ? deposit.reason ?? "fund state still unknown"
          : `deposit not yet confirmed (${deposit.status})`,
      deposit,
    };
  }

  // The deposit landed. That is not the payee being paid.
  if (args.settlesVia === "agentpay") {
    return {
      kind: "open",
      reason:
        "deposit confirmed; an agent payout settles through the x402 facilitator, " +
        "which has no read-only status call — re-settle with the same operation token",
      deposit,
    };
  }
  if (!args.rail || !args.railQuote) {
    return {
      kind: "open",
      reason: "deposit confirmed, but the settlement cannot be determined without the rail quote",
      deposit,
    };
  }
  if (!args.operation) {
    return {
      kind: "open",
      reason: "deposit confirmed, but the funded operation is not on record",
      deposit,
    };
  }

  let settlement: SettlementResult;
  try {
    settlement = await args.rail.poll(args.operation.id, args.railQuote);
  } catch {
    // A read failure says nothing about the money. Do not guess from it.
    return { kind: "open", reason: "could not read settlement status from the rail", deposit };
  }

  if (settlement.status === "settled") {
    // Now — and only now — the payee was paid, so the books may record it.
    const journal = paymentSettled({
      id: `je_${args.operation.id}`,
      orgId: args.operation.orgId,
      amount: args.railQuote.amountOut,
      fee: args.railQuote.feeIn,
      currency: args.operation.destination.asset,
      memo: `${args.operation.type} ${args.operation.id} settled (reconciled)`,
    });
    return { kind: "settled", journal, deposit, settlement };
  }

  if (settlement.status === "failed" || settlement.status === "refunded") {
    // The rail is terminal: the swap will not complete, so the payee is not
    // paid and there is nothing to book.
    return {
      kind: "failed",
      reason: settlement.failureReason ?? `settlement ${settlement.status}`,
      deposit,
      settlement,
    };
  }

  // Still in flight at the rail. The deposit is in; the payee is not yet paid.
  return {
    kind: "open",
    reason: `deposit confirmed; settlement still ${settlement.status}`,
    deposit,
  };
}
