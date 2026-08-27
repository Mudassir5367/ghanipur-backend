import { Types as MongooseTypes, type ClientSession, type Types } from 'mongoose';
import { Product } from '../models/product.model.js';
import { InventoryTransaction } from '../models/inventoryTransaction.model.js';
import { InventoryTxnType, RefType, signedDelta, OUTFLOW_TYPES } from '../constants/inventory.js';
import { ApiError } from '../utils/ApiError.js';
import type { TenantContext } from '../types/context.js';

export interface MovementInput {
  productId: string;
  type: InventoryTxnType;
  /** Magnitude for inflow/outflow types; already-signed for ADJUSTMENT. */
  quantity: number;
  refType?: RefType;
  refId?: Types.ObjectId | string | null;
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
}

/**
 * The single, concurrency-safe entry point for every stock change (§9, §36).
 *
 * Correctness guarantees:
 *  - Stock is mutated with a conditional atomic `$inc` in one operation, so two
 *    simultaneous sales can never both succeed past available stock (no
 *    read-modify-write race).
 *  - Every change appends an immutable ledger row; `currentStock` is just a cache
 *    that always equals the ledger sum and can be rebuilt via `recomputeStock`.
 */
export async function recordMovement(
  ctx: TenantContext,
  input: MovementInput,
  session?: ClientSession,
): Promise<MovementResult> {
  const product = await Product.findOne(
    { _id: input.productId, shopId: ctx.shopId, isDeleted: false },
    'trackInventory unitId currentStock',
    { session },
  );
  if (!product) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (!product.trackInventory) return { skipped: true };

  const delta = signedDelta(input.type, input.quantity);
  const isOutflow = delta < 0 && OUTFLOW_TYPES.includes(input.type);
  const guardNegative = isOutflow && !input.allowNegative;

  const filter: Record<string, unknown> = { _id: product._id, shopId: ctx.shopId, isDeleted: false };
  // Atomic guard: only decrement if enough stock remains.
  if (guardNegative) filter.currentStock = { $gte: -delta };

  const updated = await Product.findOneAndUpdate(
    filter,
    { $inc: { currentStock: delta } },
    { new: true, session, projection: 'currentStock unitId' },
  );

  if (!updated) {
    // The only way to reach here (product exists + tracked) is the stock guard.
    throw ApiError.badRequest('Insufficient stock for this operation', 'INSUFFICIENT_STOCK');
  }

  const [txn] = await InventoryTransaction.create(
    [{
      shopId: ctx.shopId,
      productId: product._id,
      type: input.type,
      quantity: delta,
      unitId: product.unitId,
      balanceAfter: updated.currentStock,
      refType: input.refType ?? RefType.MANUAL,
      refId: input.refId ?? null,
      performedBy: input.performedBy ?? null,
      note: input.note ?? '',
      occurredAt: input.occurredAt ?? new Date(),
    }],
    { session },
  );

  return { skipped: false, balanceAfter: updated.currentStock, transactionId: txn!._id.toString() };
}

/** Rebuild the cached currentStock from the ledger (repair / audit — §9). */
export async function recomputeStock(ctx: TenantContext, productId: string): Promise<number> {
  const agg = await InventoryTransaction.aggregate<{ total: number }>([
    { $match: { shopId: toObjectId(ctx.shopId), productId: toObjectId(productId) } },
    { $group: { _id: null, total: { $sum: '$quantity' } } },
  ]);
  const total = agg[0]?.total ?? 0;
  await Product.updateOne({ _id: productId, shopId: ctx.shopId }, { currentStock: total });
  return total;
}

function toObjectId(id: string): Types.ObjectId {
  return new MongooseTypes.ObjectId(id);
}
