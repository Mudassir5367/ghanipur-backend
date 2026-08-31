import { TABLES } from '../../config/dynamoTables.js';
import {
  atomicAdd,
  compositeKey,
  deleteItem,
  getItem,
  putItem,
  queryAllByPartition,
  queryOneByIndex,
  updateItem,
  withLegacyId,
} from './base.js';
import { newId } from './id.js';

/**
 * DynamoDB-backed Customer store, replacing the Mongoose `Customer` model.
 *
 * Layout: {shopId, id}. Phone is NOT unique — Mongo's index was non-unique too,
 * because two households can share a landline — so there is no guard table, just
 * a byPhone index for lookup.
 *
 * `currentBalanceMinor` is the customer's udhaar and moves ONLY through
 * adjustBalance, an atomic conditional update. It is deliberately allowed to go
 * negative: a customer who overpays is in credit, which Mongo also permitted.
 */

export const CustomerStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type CustomerStatus = (typeof CustomerStatus)[keyof typeof CustomerStatus];

export interface CustomerRecord {
  shopId: string;
  id: string;
  _id?: string;
  shopPhoneKey: string;
  shopStatusKey: string;
  name: string;
  phone?: string | null;
  altPhone?: string | null;
  address: string;
  type: string;
  notes: string;
  status: CustomerStatus;
  creditLimitMinor: number;
  openingBalanceMinor: number;
  currentBalanceMinor: number;
  lastSaleAt: string | null;
  lastPaymentAt: string | null;
  isDeleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const CUSTOMERS = TABLES.Customer as string;

export async function findById(shopId: string, id: string): Promise<CustomerRecord | null> {
  const row = await getItem<CustomerRecord>(CUSTOMERS, { shopId, id });
  return row && !row.isDeleted ? withLegacyId(row) : null;
}

export async function findByPhone(shopId: string, phone: string): Promise<CustomerRecord | null> {
  const row = await queryOneByIndex<CustomerRecord>(
    CUSTOMERS,
    'byPhone',
    'shopPhoneKey',
    compositeKey(shopId, phone),
  );
  return row && !row.isDeleted ? withLegacyId(row) : null;
}

export async function listByShop(shopId: string): Promise<CustomerRecord[]> {
  const rows = await queryAllByPartition<CustomerRecord>(CUSTOMERS, 'shopId', shopId);
  return rows.filter((c) => !c.isDeleted).map((c) => withLegacyId(c));
}

export interface CreateCustomerInput {
  shopId: string;
  name: string;
  phone?: string | null;
  altPhone?: string | null;
  address?: string;
  type?: string;
  notes?: string;
  creditLimitMinor?: number;
  openingBalanceMinor?: number;
  status?: CustomerStatus;
}

export async function create(input: CreateCustomerInput): Promise<CustomerRecord> {
  const now = new Date().toISOString();
  const status = input.status ?? CustomerStatus.ACTIVE;
  const opening = input.openingBalanceMinor ?? 0;
  const record: CustomerRecord = {
    shopId: input.shopId,
    id: newId(),
    // Customers without a phone still need a key; NONE keeps them out of the way.
    shopPhoneKey: compositeKey(input.shopId, input.phone ?? 'NONE'),
    shopStatusKey: compositeKey(input.shopId, status),
    name: input.name,
    phone: input.phone ?? null,
    altPhone: input.altPhone ?? null,
    address: input.address ?? '',
    type: input.type ?? 'INDIVIDUAL',
    notes: input.notes ?? '',
    status,
    creditLimitMinor: input.creditLimitMinor ?? 0,
    openingBalanceMinor: opening,
    currentBalanceMinor: opening,
    lastSaleAt: null,
    lastPaymentAt: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await putItem(CUSTOMERS, record);
  return withLegacyId(record);
}

export type CustomerPatch = Partial<
  Omit<CustomerRecord, 'shopId' | 'id' | '_id' | 'currentBalanceMinor' | 'createdAt'>
>;

export async function update(shopId: string, id: string, patch: CustomerPatch): Promise<CustomerRecord | null> {
  const current = await findById(shopId, id);
  if (!current) return null;
  const next: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
  if (patch.phone !== undefined) next.shopPhoneKey = compositeKey(shopId, patch.phone ?? 'NONE');
  if (patch.status !== undefined) next.shopStatusKey = compositeKey(shopId, patch.status);
  await updateItem(CUSTOMERS, { shopId, id }, next);
  return withLegacyId({ ...current, ...next } as CustomerRecord);
}

/**
 * Moves the customer's balance atomically and returns the new value.
 *
 * Positive delta = the customer owes more (a credit sale), negative = they paid.
 * No floor: an overpaying customer legitimately goes into credit, so a
 * conditional minimum here would reject valid payments.
 */
export async function adjustBalance(shopId: string, id: string, deltaMinor: number): Promise<number | null> {
  return atomicAdd(CUSTOMERS, { shopId, id }, 'currentBalanceMinor', deltaMinor);
}

export async function touchLastSale(shopId: string, id: string, at = new Date()): Promise<void> {
  await updateItem(CUSTOMERS, { shopId, id }, { lastSaleAt: at.toISOString() });
}

export async function touchLastPayment(shopId: string, id: string, at = new Date()): Promise<void> {
  await updateItem(CUSTOMERS, { shopId, id }, { lastPaymentAt: at.toISOString() });
}

export async function softDelete(shopId: string, id: string, deletedBy: string): Promise<CustomerRecord | null> {
  const current = await findById(shopId, id);
  if (!current) return null;
  const now = new Date().toISOString();
  await updateItem(CUSTOMERS, { shopId, id }, { isDeleted: true, deletedAt: now, deletedBy, updatedAt: now });
  return withLegacyId({ ...current, isDeleted: true, deletedAt: now, deletedBy });
}

/** Hard delete — seed/test teardown only. */
export async function hardDelete(shopId: string, id: string): Promise<void> {
  await deleteItem(CUSTOMERS, { shopId, id });
}
