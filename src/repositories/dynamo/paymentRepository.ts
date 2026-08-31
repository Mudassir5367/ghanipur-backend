import { TABLES } from '../../config/dynamoTables.js';
import {
  compositeKey,
  deleteItem,
  putItem,
  queryAllByPartition,
  timeKey,
  updateItem,
  withLegacyId,
} from './base.js';
import { newId } from './id.js';

/**
 * DynamoDB-backed Payment store, replacing the Mongoose model.
 *
 * Layout: {shopId, "receivedAt#id"} so a shop's payments are one date-ordered
 * Query, with `byCustomer` for a single customer's history.
 *
 * Payments are never edited or deleted in normal operation — a correction is a
 * reversal, recorded by stamping `reversedAt` on the original and writing an
 * opposing ledger entry (§79). Only that stamp is mutable.
 */

export interface PaymentRecord {
  shopId: string;
  sk: string;
  id: string;
  _id?: string;
  shopCustomerKey: string;
  customerId: string;
  amountMinor: number;
  method: string;
  reference: string;
  note: string;
  receivedBy: string | null;
  receivedAt: string;
  reversedAt: string | null;
  reversalOf: string | null;
  createdAt: string;
  updatedAt: string;
}

const PAYMENTS = TABLES.Payment as string;

export interface CreatePaymentRecord {
  shopId: string;
  customerId: string;
  amountMinor: number;
  method?: string;
  reference?: string;
  note?: string;
  receivedBy?: string | null;
  receivedAt?: Date;
  reversalOf?: string | null;
}

export async function create(input: CreatePaymentRecord): Promise<PaymentRecord> {
  const id = newId();
  const receivedAt = (input.receivedAt ?? new Date()).toISOString();
  const now = new Date().toISOString();
  const record: PaymentRecord = {
    shopId: input.shopId,
    sk: timeKey(receivedAt, id),
    id,
    shopCustomerKey: compositeKey(input.shopId, input.customerId),
    customerId: input.customerId,
    amountMinor: input.amountMinor,
    method: input.method ?? 'CASH',
    reference: input.reference ?? '',
    note: input.note ?? '',
    receivedBy: input.receivedBy ?? null,
    receivedAt,
    reversedAt: null,
    reversalOf: input.reversalOf ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await putItem(PAYMENTS, record);
  return withLegacyId(record);
}

export async function listByShop(shopId: string): Promise<PaymentRecord[]> {
  const rows = await queryAllByPartition<PaymentRecord>(PAYMENTS, 'shopId', shopId);
  return rows.map((r) => withLegacyId(r));
}

export async function listByCustomer(shopId: string, customerId: string): Promise<PaymentRecord[]> {
  const rows = await queryAllByPartition<PaymentRecord>(
    PAYMENTS,
    'shopCustomerKey',
    compositeKey(shopId, customerId),
    { indexName: 'byCustomer' },
  );
  return rows.map((r) => withLegacyId(r));
}

export async function findScoped(shopId: string, id: string): Promise<PaymentRecord | null> {
  const rows = await listByShop(shopId);
  return rows.find((p) => p.id === id) ?? null;
}

/** Stamps the reversal marker — the only mutation a payment ever takes. */
export async function markReversed(payment: PaymentRecord, at = new Date()): Promise<PaymentRecord> {
  const next = { reversedAt: at.toISOString(), updatedAt: new Date().toISOString() };
  await updateItem(PAYMENTS, { shopId: payment.shopId, sk: payment.sk }, next);
  return withLegacyId({ ...payment, ...next });
}

/** Hard delete — compensation and test teardown only. */
export async function hardDelete(payment: Pick<PaymentRecord, 'shopId' | 'sk'>): Promise<void> {
  await deleteItem(PAYMENTS, { shopId: payment.shopId, sk: payment.sk });
}
