import { TABLES } from '../../config/dynamoTables.js';
import { compositeKey, putItem, queryAllByPartition, timeKey, withLegacyId } from './base.js';
import { newId } from './id.js';
import type { LedgerEntryType, LedgerRefType } from '../../constants/sales.js';

/**
 * DynamoDB-backed CustomerLedger, replacing the Mongoose model.
 *
 * Append-only (§13, §37) — entries are never updated or deleted, and a
 * correction is a new opposing entry. That maps cleanly onto DynamoDB: this
 * repository deliberately exposes no update or delete.
 *
 * Layout: {customerId, "occurredAt#id"}, so one customer's statement is a single
 * Query already in chronological order. `byShop` covers shop-wide reporting and
 * `byRef` finds the entries a sale or payment produced (used by reversals).
 */

export interface CustomerLedgerRecord {
  customerId: string;
  sk: string;
  id: string;
  _id?: string;
  shopId: string;
  /** "<refType>#<refId>" — locates entries created by a given sale/payment. */
  refKey: string;
  entryType: LedgerEntryType;
  debitMinor: number;
  creditMinor: number;
  balanceAfterMinor: number;
  refType: LedgerRefType;
  refId: string | null;
  note: string;
  createdBy: string | null;
  occurredAt: string;
  createdAt: string;
}

const LEDGER = TABLES.CustomerLedger as string;

export interface CreateLedgerEntry {
  shopId: string;
  customerId: string;
  entryType: LedgerEntryType;
  debitMinor?: number;
  creditMinor?: number;
  balanceAfterMinor: number;
  refType: LedgerRefType;
  refId?: string | null;
  note?: string;
  createdBy?: string | null;
  occurredAt?: Date;
}

export async function append(entry: CreateLedgerEntry): Promise<CustomerLedgerRecord> {
  const id = newId();
  const occurredAt = (entry.occurredAt ?? new Date()).toISOString();
  const record: CustomerLedgerRecord = {
    customerId: entry.customerId,
    sk: timeKey(occurredAt, id),
    id,
    shopId: entry.shopId,
    refKey: compositeKey(entry.refType, entry.refId ?? 'NONE'),
    entryType: entry.entryType,
    debitMinor: entry.debitMinor ?? 0,
    creditMinor: entry.creditMinor ?? 0,
    balanceAfterMinor: entry.balanceAfterMinor,
    refType: entry.refType,
    refId: entry.refId ?? null,
    note: entry.note ?? '',
    createdBy: entry.createdBy ?? null,
    occurredAt,
    createdAt: new Date().toISOString(),
  };
  await putItem(LEDGER, record);
  return withLegacyId(record);
}

/** One customer's statement, newest first. */
export async function listByCustomer(customerId: string): Promise<CustomerLedgerRecord[]> {
  const rows = await queryAllByPartition<CustomerLedgerRecord>(LEDGER, 'customerId', customerId);
  return rows.map((r) => withLegacyId(r)).sort((a, b) => b.sk.localeCompare(a.sk));
}

/** Every entry for a shop — reporting. */
export async function listByShop(shopId: string): Promise<CustomerLedgerRecord[]> {
  const rows = await queryAllByPartition<CustomerLedgerRecord>(LEDGER, 'shopId', shopId, { indexName: 'byShop' });
  return rows.map((r) => withLegacyId(r));
}

/** Entries a given sale or payment produced — used when reversing it. */
export async function listByRef(refType: LedgerRefType, refId: string): Promise<CustomerLedgerRecord[]> {
  const rows = await queryAllByPartition<CustomerLedgerRecord>(
    LEDGER,
    'refKey',
    compositeKey(refType, refId),
    { indexName: 'byRef' },
  );
  return rows.map((r) => withLegacyId(r));
}
