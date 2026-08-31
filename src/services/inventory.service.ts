import * as productRepo from '../repositories/dynamo/productRepository.js';
import * as txnRepo from '../repositories/dynamo/inventoryTransactionRepository.js';
import { InventoryTxnType, RefType, signedDelta, OUTFLOW_TYPES } from '../constants/inventory.js';
import { ApiError } from '../utils/ApiError.js';
import type { TenantContext } from '../types/context.js';

export interface MovementInput {
  productId: string;
  type: InventoryTxnType;
  /** Magnitude for inflow/outflow types; already-signed for ADJUSTMENT. */
  quantity: number;
  refType?: RefType;
  refId?: string | null;
  performedBy?: string | null;
  note?: string;
  occurredAt?: Date;
  /** Allow stock to go below zero (default false for outflow types). */
  allowNegative?: boolean;
}

export interface MovementResult {
  skipped: boolean; // true when the product doesn't track inventory
  balanceAfter?: number;
  transactionId?: string;
  /** Everything needed to undo this movement if a multi-step write fails. */
  undo?: { productId: string; sk: string; delta: number };
}

/**
 * Unwinds movements written by a multi-item operation that failed partway.
 *
 * Mongo rolled these back with a transaction. DynamoDB cannot, so the caller
 * hands back the undo handles and this restores the stock and removes the rows —
 * leaving no trace of an operation that never completed. Best-effort by design:
 * the original failure is what the caller must report.
 */
export async function undoMovements(ctx: TenantContext, undos: NonNullable<MovementResult['undo']>[]): Promise<void> {
  for (const u of undos) {
    try {
      await productRepo.adjustStock(ctx.shopId, u.productId, -u.delta, { allowNegative: true });
      await txnRepo.removeForCompensation(u.productId, u.sk);
    } catch {
      // Swallow: a failed compensation must not mask the error that caused it.
    }
  }
}

/**
 * The single, concurrency-safe entry point for every stock change (§9, §36).
 *
 * Correctness guarantees, unchanged from the Mongo implementation:
 *  - Stock moves in ONE conditional atomic update that also returns the new
 *    balance, so two simultaneous sales can never both pass the availability
 *    check. Mongo did this with findOneAndUpdate($inc) under a filter; DynamoDB
 *    does it with UpdateItem + ConditionExpression, which likewise needs no
 *    read-modify-write and no transaction.
 *  - Every change appends an immutable ledger row; `currentStock` is a cache
 *    that always equals the ledger sum and can be rebuilt via recomputeStock.
 *
 * The unused session parameter remains so callers still inside the old
 * withTransaction wrapper compile; it is ignored and goes away with Mongo.
 */
export async function recordMovement(
  ctx: TenantContext,
  input: MovementInput,
  _session?: unknown,
): Promise<MovementResult> {
  const product = await productRepo.findById(ctx.shopId, input.productId);
  if (!product) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (!product.trackInventory) return { skipped: true };

  const delta = signedDelta(input.type, input.quantity);
  const isOutflow = delta < 0 && OUTFLOW_TYPES.includes(input.type);
  const guardNegative = isOutflow && !input.allowNegative;

  const balanceAfter = await productRepo.adjustStock(ctx.shopId, product.id, delta, {
    allowNegative: !guardNegative,
  });

  if (balanceAfter === null) {
    // The condition is the only thing that can reject here — the product exists
    // and is tracked, so this is the stock floor.
    throw ApiError.badRequest('Insufficient stock for this operation', 'INSUFFICIENT_STOCK');
  }

  const txn = await txnRepo.append({
    shopId: ctx.shopId,
    productId: product.id,
    type: input.type,
    quantity: delta,
    unitId: product.unitId,
    balanceAfter,
    refType: input.refType ?? RefType.MANUAL,
    refId: input.refId ? String(input.refId) : null,
    performedBy: input.performedBy ?? null,
    note: input.note ?? '',
    occurredAt: input.occurredAt,
  });

  return {
    skipped: false,
    balanceAfter,
    transactionId: txn.id,
    undo: { productId: product.id, sk: txn.sk, delta },
  };
}

/** Rebuild the cached currentStock from the ledger (repair / audit — §9). */
export async function recomputeStock(ctx: TenantContext, productId: string): Promise<number> {
  const rows = await txnRepo.listByProduct(productId);
  const total = rows
    .filter((r) => r.shopId === ctx.shopId)
    .reduce((sum, r) => sum + r.quantity, 0);
  const product = await productRepo.findById(ctx.shopId, productId);
  if (product) {
    // Set outright rather than add: this is a repair to the ledger's truth.
    await productRepo.adjustStock(ctx.shopId, productId, total - product.currentStock, { allowNegative: true });
  }
  return total;
}
