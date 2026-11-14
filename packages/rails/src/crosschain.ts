import type { ChainAsset, Operation } from "@crewpay/domain";
import type { DepositProof, Quote, SettlementRail, SettlementResult } from "./settlement.ts";

/**
 * Cross-chain settlement, routed to a rail that can actually carry it.
 *
 * A payee can be owed money on a chain the treasury is not on. Rather than let
 * one rail pretend to cover every corridor, this routes each operation:
 *
 *   - a NEAR corridor goes to the NEAR rail, which really broadcasts;
 *   - a corridor into another chain is *priced* for real (1Click's keyless dry
 *     quote) and then reported as unreachable, because the swap into the
 *     destination asset needs a mainnet solver this deployment cannot reach.
 *
 * The unreachable verdict is a named failure, never a settlement: a payee is
 * never told they were paid on a chain the money did not reach. The real price
 * rides along so an operator sees exactly what the corridor would have cost.
 *
 * This is a router, not a money path. `settleOperation` still drives it, so the
 * policy gate, the funding check and the ledger are unchanged.
 */

/** 1Click's keyless price for a corridor, from a `dry: true` quote. */
export interface PricePreview {
  readonly correlationId: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly amountInUsd?: string;
  readonly amountOutUsd?: string;
  readonly withdrawFee?: string;
  readonly timeEstimate?: number;
}

/** Prices an outbound corridor without moving anything. */
export type PriceSource = (input: {
  origin: ChainAsset;
  destination: ChainAsset;
  amount: bigint;
  recipient: string;
  refundTo: string;
}) => Promise<PricePreview>;

export interface CrossChainRailConfig {
  /** Settles corridors whose destination is the treasury's own chain. */
  readonly nearRail: SettlementRail;
  /** The asset the treasury holds and pays from, e.g. `near:usdt`. */
  readonly treasury: ChainAsset;
  /** Prices a corridor the treasury cannot reach. Optional: skips the preview. */
  readonly price?: PriceSource;
}

/** The named, non-settling answer for a corridor no wired rail can carry. */
export const UNREACHABLE_REASON =
  "crosschain_unreachable: the destination chain is not the treasury's, and the swap runs on " +
  "mainnet, which this deployment cannot reach; no destination tx hash is claimed";

export interface UnreachableResult extends SettlementResult {
  readonly status: "failed";
  readonly failureReason: typeof UNREACHABLE_REASON;
  readonly unreachable: true;
}

export function isUnreachable(result: SettlementResult): result is UnreachableResult {
  return (result as { unreachable?: boolean }).unreachable === true;
}

/**
 * Routes each operation to the rail that can carry its corridor, and fails an
 * unreachable corridor by name. `quote`, `submit` and `poll` stay
 * `SettlementRail`-shaped so it drops into the money path unchanged.
 */
export class CrossChainRail implements SettlementRail {
  readonly name = "crosschain";
  private readonly nearRail: SettlementRail;
  private readonly treasury: ChainAsset;
  private readonly price: PriceSource | undefined;
  /** operationId -> the price preview attached to the last quote, for the report. */
  private readonly previews = new Map<string, PricePreview>();
  /** operationIds this rail actually routes to the NEAR rail. */
  private readonly reachable = new Set<string>();

  constructor(cfg: CrossChainRailConfig) {
    this.nearRail = cfg.nearRail;
    this.treasury = cfg.treasury;
    this.price = cfg.price;
  }

  private reaches(op: Operation): boolean {
    return op.destination.chain.toLowerCase() === this.treasury.chain.toLowerCase();
  }

  /**
   * The money path calls this before funding. An unreachable corridor is
   * refused here, so no deposit is ever broadcast for a swap this deployment
   * cannot complete.
   */
  preflight(op: Operation): { ok: true } | { ok: false; reason: string } {
    return this.reaches(op) ? { ok: true } : { ok: false, reason: UNREACHABLE_REASON };
  }

  async quote(op: Operation): Promise<Quote> {
    if (this.reaches(op)) {
      this.reachable.add(op.id);
      return this.nearRail.quote(op);
    }
    // Price the corridor for real, then hand back a quote the money path can
    // carry; submit is where the unreachable verdict is returned.
    if (this.price) {
      try {
        const preview = await this.price({
          origin: op.origin,
          destination: op.destination,
          amount: op.amount.amount,
          recipient: op.recipient,
          refundTo: op.refundTo,
        });
        this.previews.set(op.id, preview);
      } catch {
        // A price is a nicety; its absence must not mask the real verdict.
      }
    }
    return {
      quoteId: `crosschain_${op.id}`,
      amountIn: op.amount.amount,
      minAmountIn: op.amount.amount,
      amountOut: op.amount.amount,
      minAmountOut: op.amount.amount,
      feeIn: 0n,
      depositAddress: op.recipient,
      deadline: op.deadline,
      evidence: "crosschain: destination swap is mainnet-only and is not executed here",
    };
  }

  submit(op: Operation, quote: Quote, proof?: DepositProof): Promise<SettlementResult> {
    if (this.reaches(op)) return this.nearRail.submit(op, quote, proof);
    return Promise.resolve(this.unreachable(op.id, quote.quoteId));
  }

  poll(operationId: string, quote?: Quote): Promise<SettlementResult> {
    if (this.reachable.has(operationId)) return this.nearRail.poll(operationId, quote);
    return Promise.resolve(this.unreachable(operationId, quote?.quoteId));
  }

  private unreachable(operationId: string, quoteId?: string): UnreachableResult {
    const preview = this.previews.get(operationId);
    return {
      operationId,
      status: "failed",
      ...(quoteId ? { quoteId } : {}),
      ...(preview
        ? {
            evidence: JSON.stringify({
              crosschainPrice: {
                amountIn: preview.amountIn,
                amountOut: preview.amountOut,
                ...(preview.amountOutUsd ? { amountOutUsd: preview.amountOutUsd } : {}),
                ...(preview.withdrawFee ? { withdrawFee: preview.withdrawFee } : {}),
              },
            }),
          }
        : {}),
      failureReason: UNREACHABLE_REASON,
      unreachable: true,
    };
  }
}
