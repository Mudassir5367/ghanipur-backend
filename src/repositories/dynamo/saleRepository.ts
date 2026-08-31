import { TABLES } from '../../config/dynamoTables.js';
import {
  compositeKey,
  deleteItem,
  getItem,
  putItem,
  putWithGuards,
  queryAllByPartition,
  queryOneByIndex,
  releaseGuard,
  timeKey,
  updateItem,
  withLegacyId,
  type GuardSpec,
} from './base.js';
import { newId } from './id.js';
import type { SaleType, SaleStatus } from '../../constants/sales.js';

/**
 * DynamoDB-backed Sale + SaleItem stores, replacing the Mongoose models.
 *
 * Sale layout: {shopId, "soldAt#id"} — a shop's sales come back in date order
 * from one Query, which is what every sales screen and report wants. `byId`
 * exists because a sale is also addressed directly by id, and the partition key
 * alone cannot find it without knowing soldAt.
 *
 * The `{shopId, code}` unique index becomes the SaleCode guard table, written in
 * the same transaction as the sale — two concurrent sales can never take the
 * same receipt number.
 *
 * Items live in their own table keyed {saleId, id}, so a sale's lines are one
 * Query, and `byProduct` answers "what did we sell of this product".
 */

export interface SaleRecord {
  shopId: string;
  sk: string;
  id: string;
  _id?: string;
  code: string;
  /** "<shopId>#<customerId|WALKIN>" and "<shopId>#<type>" for the GSIs. */
  shopCustomerKey: string;
  shopTypeKey: string;
  customerId: string | null;
  customerPhone: string;
  type: SaleType;
  status: SaleStatus;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
  paymentMethod: string | null;
  note: string;
  soldBy: string | null;
  soldAt: string;
  reversalOf: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaleItemRecord {
  saleId: string;
  id: string;
  _id?: string;
  shopId: string;
  shopProductKey: string;
  productId: string;
  name: string;
  quantity: number;
  unitId: string;
  unitPriceMinor: number;
  lineTotalMinor: number;
  createdAt: string;
}

const SALES = TABLES.Sale as string;
const SALE_ITEMS = TABLES.SaleItem as string;
const CODE_GUARD = TABLES.SaleCode as string;

const WALKIN = 'WALKIN';

function codeGuard(shopId: string, code: string): GuardSpec {
  return {
    table: CODE_GUARD,
    key: { shopCodeKey: compositeKey(shopId, code), sk: 'GUARD' },
    pkName: 'shopCodeKey',
    field: 'code',
  };
}

export async function findById(id: string): Promise<SaleRecord | null> {
  return withLegacyId(await queryOneByIndex<SaleRecord>(SALES, 'byId', 'id', id));
}

/** Scoped fetch — never trust a caller-supplied id to belong to this shop (§22). */
export async function findScoped(shopId: string, id: string): Promise<SaleRecord | null> {
  const sale = await findById(id);
  return sale && sale.shopId === shopId ? sale : null;
}

export async function findByCode(shopId: string, code: string): Promise<SaleRecord | null> {
  const rows = await queryAllByPartition<SaleRecord>(SALES, 'shopId', shopId, { indexName: 'byCode' });
  return withLegacyId(rows.find((s) => s.code === code) ?? null);
}

export async function listByShop(shopId: string): Promise<SaleRecord[]> {
  const rows = await queryAllByPartition<SaleRecord>(SALES, 'shopId', shopId);
  return rows.map((r) => withLegacyId(r));
}

export async function listByCustomer(shopId: string, customerId: string): Promise<SaleRecord[]> {
  const rows = await queryAllByPartition<SaleRecord>(
    SALES,
    'shopCustomerKey',
    compositeKey(shopId, customerId),
    { indexName: 'byCustomer' },
  );
  return rows.map((r) => withLegacyId(r));
}

export interface CreateSaleInput {
  shopId: string;
  code: string;
  customerId?: string | null;
  customerPhone?: string;
  type: SaleType;
  status: SaleStatus;
  subtotalMinor: number;
  taxMinor?: number;
  totalMinor: number;
  paidMinor?: number;
  dueMinor?: number;
  paymentMethod?: string | null;
  note?: string;
  soldBy?: string | null;
  soldAt?: Date;
  reversalOf?: string | null;
}

/** Throws UniqueConstraintError('code') if the receipt number is taken. */
export async function create(input: CreateSaleInput): Promise<SaleRecord> {
  const id = newId();
  const soldAt = (input.soldAt ?? new Date()).toISOString();
  const now = new Date().toISOString();
  const record: SaleRecord = {
    shopId: input.shopId,
    sk: timeKey(soldAt, id),
    id,
    code: input.code,
    shopCustomerKey: compositeKey(input.shopId, input.customerId ?? WALKIN),
    shopTypeKey: compositeKey(input.shopId, input.type),
    customerId: input.customerId ?? null,
    customerPhone: input.customerPhone ?? '',
    type: input.type,
    status: input.status,
    subtotalMinor: input.subtotalMinor,
    taxMinor: input.taxMinor ?? 0,
    totalMinor: input.totalMinor,
    paidMinor: input.paidMinor ?? 0,
    dueMinor: input.dueMinor ?? 0,
    paymentMethod: input.paymentMethod ?? null,
    note: input.note ?? '',
    soldBy: input.soldBy ?? null,
    soldAt,
    reversalOf: input.reversalOf ?? null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await putWithGuards(SALES, record, [codeGuard(input.shopId, input.code)]);
  return withLegacyId(record);
}

export type SalePatch = Partial<Pick<SaleRecord, 'status' | 'paidMinor' | 'dueMinor' | 'note' | 'cancelledAt'>>;

export async function update(shopId: string, sale: SaleRecord, patch: SalePatch): Promise<SaleRecord> {
  const next = { ...patch, updatedAt: new Date().toISOString() };
  await updateItem(SALES, { shopId, sk: sale.sk }, next);
  return withLegacyId({ ...sale, ...next });
}

/** Hard delete — compensation for a failed multi-write, and test teardown. */
export async function hardDelete(sale: Pick<SaleRecord, 'shopId' | 'sk' | 'code'>): Promise<void> {
  await deleteItem(SALES, { shopId: sale.shopId, sk: sale.sk });
  await releaseGuard(codeGuard(sale.shopId, sale.code));
}

// ---- Sale items ----

export interface CreateSaleItemInput {
  shopId: string;
  saleId: string;
  productId: string;
  name: string;
  quantity: number;
  unitId: string;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export async function addItem(input: CreateSaleItemInput): Promise<SaleItemRecord> {
  const record: SaleItemRecord = {
    saleId: input.saleId,
    id: newId(),
    shopId: input.shopId,
    shopProductKey: compositeKey(input.shopId, input.productId),
    productId: input.productId,
    name: input.name,
    quantity: input.quantity,
    unitId: input.unitId,
    unitPriceMinor: input.unitPriceMinor,
    lineTotalMinor: input.lineTotalMinor,
    createdAt: new Date().toISOString(),
  };
  await putItem(SALE_ITEMS, record);
  return withLegacyId(record);
}

export async function listItems(saleId: string): Promise<SaleItemRecord[]> {
  const rows = await queryAllByPartition<SaleItemRecord>(SALE_ITEMS, 'saleId', saleId);
  return rows.map((r) => withLegacyId(r));
}

export async function listItemsByProduct(shopId: string, productId: string): Promise<SaleItemRecord[]> {
  const rows = await queryAllByPartition<SaleItemRecord>(
    SALE_ITEMS,
    'shopProductKey',
    compositeKey(shopId, productId),
    { indexName: 'byProduct' },
  );
  return rows.map((r) => withLegacyId(r));
}

export async function deleteItems(saleId: string): Promise<void> {
  const items = await listItems(saleId);
  for (const item of items) await deleteItem(SALE_ITEMS, { saleId, id: item.id });
}

/** Every line for a shop — reporting joins these against sales in memory. */
export async function listAllItemsForSales(saleIds: string[]): Promise<SaleItemRecord[]> {
  const pages = await Promise.all(saleIds.map((id) => listItems(id)));
  return pages.flat();
}

export async function getSaleItemTable(): Promise<string> {
  return SALE_ITEMS;
}

export async function findItemById(saleId: string, id: string): Promise<SaleItemRecord | null> {
  return withLegacyId(await getItem<SaleItemRecord>(SALE_ITEMS, { saleId, id }));
}
