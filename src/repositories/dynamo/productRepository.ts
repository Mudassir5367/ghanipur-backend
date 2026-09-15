import { TABLES } from '../../config/dynamoTables.js';
import {
  atomicAdd,
  compositeKey,
  deleteItem,
  getItem,
  putWithGuards,
  queryAllByPartition,
  queryOneByIndex,
  releaseGuard,
  updateItem,
  withLegacyId,
  type GuardSpec,
} from './base.js';
import { newId } from './id.js';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../config/dynamo.js';

/**
 * DynamoDB-backed Product store, replacing the Mongoose `Product` model.
 *
 * Layout: {shopId, id}. Two Mongo unique indexes become guard tables (slug and
 * sku, both per shop). `currentStock` is mutated ONLY through adjustStock, which
 * is a conditional atomic update — never read-modify-write.
 */

export const ProductStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

export interface ProductRecord {
  shopId: string;
  id: string;
  _id?: string;
  shopSlugKey: string;
  shopSkuKey: string;
  shopCategoryKey: string;
  /** "<shopId>#<status>#<isAvailable>" — storefront filtering in one Query. */
  shopStatusAvailKey: string;
  categoryId: string;
  name: string;
  sku: string;
  slug: string;
  description: string;
  images: string[];
  unitId: string;
  unitValue: number;
  /** The product's Cost Price as entered (deliveries default to it; unchanged by purchases). */
  purchaseCostMinor: number;
  sellingPriceMinor: number;
  /** Default supplier/vendor for the product. */
  supplier?: string;
  /**
   * Running totals over stock purchases (opening stock + Add Stock), for the
   * quantity-weighted average cost. Absent on products created before purchase
   * costing existed — see averageCostMinor and addPurchaseCost.
   */
  costBasisQty?: number;
  costBasisMinor?: number;
  taxConfig: { rate: number; inclusive: boolean };
  minStock: number;
  currentStock: number;
  trackInventory: boolean;
  isAvailable: boolean;
  deliveryAvailable: boolean;
  status: ProductStatus;
  isDeleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const PRODUCTS = TABLES.Product as string;
const SLUG_GUARD = TABLES.ProductSlugGuard as string;
const SKU_GUARD = TABLES.ProductSkuGuard as string;

const availKey = (shopId: string, status: ProductStatus, isAvailable: boolean): string =>
  compositeKey(shopId, status, isAvailable);

function slugGuard(shopId: string, slug: string): GuardSpec {
  return {
    table: SLUG_GUARD,
    key: { shopSlugKey: compositeKey(shopId, slug), sk: 'GUARD' },
    pkName: 'shopSlugKey',
    field: 'slug',
  };
}

function skuGuard(shopId: string, sku: string): GuardSpec {
  return {
    table: SKU_GUARD,
    key: { shopSkuKey: compositeKey(shopId, sku), sk: 'GUARD' },
    pkName: 'shopSkuKey',
    field: 'sku',
  };
}

export async function findById(shopId: string, id: string): Promise<ProductRecord | null> {
  const row = await getItem<ProductRecord>(PRODUCTS, { shopId, id });
  return row && !row.isDeleted ? withLegacyId(row) : null;
}

export async function findBySlug(shopId: string, slug: string): Promise<ProductRecord | null> {
  const row = await queryOneByIndex<ProductRecord>(PRODUCTS, 'bySlug', 'shopSlugKey', compositeKey(shopId, slug));
  return row && !row.isDeleted ? withLegacyId(row) : null;
}

export async function slugExists(shopId: string, slug: string): Promise<boolean> {
  return (await getItem(SLUG_GUARD, { shopSlugKey: compositeKey(shopId, slug), sk: 'GUARD' })) !== null;
}

export async function skuExists(shopId: string, sku: string): Promise<boolean> {
  return (await getItem(SKU_GUARD, { shopSkuKey: compositeKey(shopId, sku), sk: 'GUARD' })) !== null;
}

export async function listByShop(shopId: string): Promise<ProductRecord[]> {
  const rows = await queryAllByPartition<ProductRecord>(PRODUCTS, 'shopId', shopId);
  return rows.filter((p) => !p.isDeleted).map((p) => withLegacyId(p));
}

export async function listByCategory(shopId: string, categoryId: string): Promise<ProductRecord[]> {
  const rows = await queryAllByPartition<ProductRecord>(
    PRODUCTS,
    'shopCategoryKey',
    compositeKey(shopId, categoryId),
    { indexName: 'byCategory' },
  );
  return rows.filter((p) => !p.isDeleted).map((p) => withLegacyId(p));
}

/** Storefront listing: active + available only, straight off the byStatus index. */
export async function listPubliclyVisible(shopId: string): Promise<ProductRecord[]> {
  const rows = await queryAllByPartition<ProductRecord>(
    PRODUCTS,
    'shopStatusAvailKey',
    availKey(shopId, ProductStatus.ACTIVE, true),
    { indexName: 'byStatus' },
  );
  return rows.filter((p) => !p.isDeleted).map((p) => withLegacyId(p));
}

export interface CreateProductInput {
  shopId: string;
  categoryId: string;
  name: string;
  sku: string;
  slug: string;
  unitId: string;
  sellingPriceMinor: number;
  purchaseCostMinor?: number;
  supplier?: string;
  description?: string;
  images?: string[];
  unitValue?: number;
  taxConfig?: { rate: number; inclusive: boolean };
  minStock?: number;
  trackInventory?: boolean;
  isAvailable?: boolean;
  deliveryAvailable?: boolean;
  status?: ProductStatus;
}

/** Throws UniqueConstraintError('slug' | 'sku'). Stock always starts at 0 —
 *  opening stock is recorded as an inventory movement, never set directly. */
export async function create(input: CreateProductInput): Promise<ProductRecord> {
  const now = new Date().toISOString();
  const status = input.status ?? ProductStatus.ACTIVE;
  const isAvailable = input.isAvailable ?? true;
  const record: ProductRecord = {
    shopId: input.shopId,
    id: newId(),
    shopSlugKey: compositeKey(input.shopId, input.slug),
    shopSkuKey: compositeKey(input.shopId, input.sku),
    shopCategoryKey: compositeKey(input.shopId, input.categoryId),
    shopStatusAvailKey: availKey(input.shopId, status, isAvailable),
    categoryId: input.categoryId,
    name: input.name,
    sku: input.sku,
    slug: input.slug,
    description: input.description ?? '',
    images: input.images ?? [],
    unitId: input.unitId,
    unitValue: input.unitValue ?? 1,
    purchaseCostMinor: input.purchaseCostMinor ?? 0,
    sellingPriceMinor: input.sellingPriceMinor,
    supplier: input.supplier ?? '',
    // No purchases yet; opening stock is added through addPurchaseCost.
    costBasisQty: 0,
    costBasisMinor: 0,
    taxConfig: input.taxConfig ?? { rate: 0, inclusive: true },
    minStock: input.minStock ?? 0,
    currentStock: 0,
    trackInventory: input.trackInventory ?? true,
    isAvailable,
    deliveryAvailable: input.deliveryAvailable ?? true,
    status,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await putWithGuards(PRODUCTS, record, [slugGuard(input.shopId, input.slug), skuGuard(input.shopId, input.sku)]);
  return withLegacyId(record);
}

export type ProductPatch = Partial<
  Omit<ProductRecord, 'shopId' | 'id' | '_id' | 'slug' | 'sku' | 'currentStock' | 'costBasisQty' | 'costBasisMinor' | 'createdAt'>
>;

/**
 * Average cost price across stock purchases, weighted by quantity. Falls back to
 * the entered Cost Price when there are no costed purchases — which also keeps
 * products created before purchase costing exactly as they were.
 */
export function averageCostMinor(p: Pick<ProductRecord, 'purchaseCostMinor' | 'costBasisQty' | 'costBasisMinor'>): number {
  const qty = p.costBasisQty ?? 0;
  return qty > 0 ? Math.round((p.costBasisMinor ?? 0) / qty) : p.purchaseCostMinor;
}

/**
 * Adds a purchase (quantity and its total cost) to the running totals, atomically.
 *
 * `seed` is for a product created before purchase costing: its earlier purchases
 * are folded in exactly once. The seeded write only succeeds while the totals are
 * still absent, so two concurrent first purchases cannot both seed — the loser
 * falls back to a plain ADD.
 */
export async function addPurchaseCost(
  shopId: string,
  id: string,
  qty: number,
  costMinor: number,
  seed?: { qty: number; costMinor: number },
): Promise<void> {
  if (seed) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: PRODUCTS,
        Key: { shopId, id },
        UpdateExpression: 'SET costBasisQty = :q, costBasisMinor = :c',
        ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(costBasisQty)',
        ExpressionAttributeValues: { ':q': seed.qty + qty, ':c': seed.costMinor + costMinor },
      }));
      return;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  await ddb.send(new UpdateCommand({
    TableName: PRODUCTS,
    Key: { shopId, id },
    UpdateExpression: 'ADD costBasisQty :q, costBasisMinor :c',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':q': qty, ':c': costMinor },
  }));
}

export async function update(shopId: string, id: string, patch: ProductPatch): Promise<ProductRecord | null> {
  const current = await findById(shopId, id);
  if (!current) return null;
  const next: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
  // Derived index keys must follow their sources or the GSIs go stale.
  if (patch.categoryId !== undefined) next.shopCategoryKey = compositeKey(shopId, patch.categoryId);
  if (patch.status !== undefined || patch.isAvailable !== undefined) {
    next.shopStatusAvailKey = availKey(
      shopId,
      patch.status ?? current.status,
      patch.isAvailable ?? current.isAvailable,
    );
  }
  await updateItem(PRODUCTS, { shopId, id }, next);
  return withLegacyId({ ...current, ...next } as ProductRecord);
}

/**
 * Applies a stock delta atomically and returns the new balance, or null if it
 * would go negative.
 *
 * This replaces Mongo's `findOneAndUpdate({$inc}, {new:true})` inside a
 * transaction. A single conditional UpdateItem both applies the change and
 * reports the result, so two concurrent sales can never both pass a stock check
 * and oversell — the loser's condition fails and it gets null.
 *
 * `allowNegative` is for untracked products, which Mongo also let drift.
 */
export async function adjustStock(
  shopId: string,
  id: string,
  delta: number,
  opts: { allowNegative?: boolean } = {},
): Promise<number | null> {
  return atomicAdd(PRODUCTS, { shopId, id }, 'currentStock', delta, {
    ...(opts.allowNegative ? {} : { minResult: 0 }),
  });
}

export async function softDelete(shopId: string, id: string, deletedBy: string): Promise<ProductRecord | null> {
  const current = await findById(shopId, id);
  if (!current) return null;
  const now = new Date().toISOString();
  await updateItem(PRODUCTS, { shopId, id }, { isDeleted: true, deletedAt: now, deletedBy, updatedAt: now });
  // Free both names so the shop can reuse them.
  await releaseGuard(slugGuard(shopId, current.slug));
  await releaseGuard(skuGuard(shopId, current.sku));
  return withLegacyId({ ...current, isDeleted: true, deletedAt: now, deletedBy });
}

/** Hard delete — seed/test teardown only. */
export async function hardDelete(shopId: string, id: string, slug: string, sku: string): Promise<void> {
  await deleteItem(PRODUCTS, { shopId, id });
  await releaseGuard(slugGuard(shopId, slug));
  await releaseGuard(skuGuard(shopId, sku));
}
