import { TABLES } from '../../config/dynamoTables.js';
import { compositeKey, putItem, queryAllByPartition, timeKey, withLegacyId } from './base.js';
import { newId } from './id.js';
import type { InventoryTxnType, RefType } from '../../constants/inventory.js';

/**
 * DynamoDB-backed InventoryTransaction, replacing the Mongoose model.
 *
 * Append-only stock ledger (§9): never updated or deleted after creation, so
 * this repository exposes no mutation. A reversal is a new opposing movement.
 *
 * Layout: {productId, "occurredAt#id"} — one product's movement history is a
 * single ordered Query. `byShopType` powers shop-wide wastage/adjustment
 * reporting, `byRef` finds the movements a sale or delivery produced.
 */

export interface InventoryTransactionRecord {
  productId: string;
  sk: string;
  id: string;
  _id?: string;
  shopId: string;
  /** "<shopId>#<type>" — wastage/adjustment reporting without a Scan. */
  shopTypeKey: string;
  /** "<refType>#<refId>" — movements produced by one sale/delivery. */
  refKey: string;
  type: InventoryTxnType;
  quantity: number;
  unitId: string;
  balanceAfter: number;
  refType: RefType;
  refId: string | null;
  performedBy: string | null;
  note: string;
  occurredAt: string;
  createdAt: string;
}

const TXNS = TABLES.InventoryTransaction as string;

export interface CreateMovement {
  shopId: string;
  productId: string;
  type: InventoryTxnType;
  quantity: number;
  unitId: string;
  balanceAfter: number;
  refType: RefType;
  refId?: string | null;
  performedBy?: string | null;
  note?: string;
  occurredAt?: Date;
}

export async function append(input: CreateMovement): Promise<InventoryTransactionRecord> {
  const id = newId();
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();
  const record: InventoryTransactionRecord = {
    productId: input.productId,
    sk: timeKey(occurredAt, id),
    id,
    shopId: input.shopId,
    shopTypeKey: compositeKey(input.shopId, input.type),
    refKey: compositeKey(input.refType, input.refId ?? 'NONE'),
    type: input.type,
    quantity: input.quantity,
    unitId: input.unitId,
    balanceAfter: input.balanceAfter,
    refType: input.refType,
    refId: input.refId ?? null,
    performedBy: input.performedBy ?? null,
    note: input.note ?? '',
    occurredAt,
    createdAt: new Date().toISOString(),
  };
  await putItem(TXNS, record);
  return withLegacyId(record);
}

/** One product's movement history, newest first. */
export async function listByProduct(productId: string): Promise<InventoryTransactionRecord[]> {
  const rows = await queryAllByPartition<InventoryTransactionRecord>(TXNS, 'productId', productId);
  return rows.map((r) => withLegacyId(r)).sort((a, b) => b.sk.localeCompare(a.sk));
}

/** Shop-wide movements of one type (e.g. WASTAGE) — reporting. */
export async function listByShopType(shopId: string, type: InventoryTxnType): Promise<InventoryTransactionRecord[]> {
  const rows = await queryAllByPartition<InventoryTransactionRecord>(
    TXNS,
    'shopTypeKey',
    compositeKey(shopId, type),
    { indexName: 'byShopType' },
  );
  return rows.map((r) => withLegacyId(r));
}

/**
 * Removes a movement row. COMPENSATION ONLY.
 *
 * The ledger is append-only in normal operation — a return or correction is a
 * new opposing movement, never a deletion. This exists solely to unwind a
 * multi-item write that failed partway: Mongo rolled those rows back with a
 * transaction, and without it a sale that never completed would leave stock
 * movements referencing a sale that does not exist.
 */
export async function removeForCompensation(productId: string, sk: string): Promise<void> {
  const { deleteItem } = await import('./base.js');
  await deleteItem(TXNS, { productId, sk });
}

export async function listByRef(refType: RefType, refId: string): Promise<InventoryTransactionRecord[]> {
  const rows = await queryAllByPartition<InventoryTransactionRecord>(
    TXNS,
    'refKey',
    compositeKey(refType, refId),
    { indexName: 'byRef' },
  );
  return rows.map((r) => withLegacyId(r));
}
