import { TABLES } from '../../config/dynamoTables.js';
import { getItem, putItem, updateItem } from './base.js';

/**
 * DynamoDB-backed ShopSettings, replacing the Mongoose model.
 *
 * One item per shop at {shopId, sk:"SETTINGS"}. The Mongo schema had a unique
 * index on shopId; here that is the partition key itself, so uniqueness needs no
 * guard table.
 */

/** Default configurable lists a new shop starts with (all editable — §5, §11, §14). */
export const DEFAULT_PAYMENT_METHODS = ['CASH', 'BANK', 'EASYPAISA', 'JAZZCASH', 'CARD', 'OTHER'];
export const DEFAULT_CUSTOMER_TYPES = ['INDIVIDUAL', 'HOUSEHOLD', 'HOTEL', 'RESTAURANT', 'BUSINESS', 'OTHER'];

export interface ShopSettingsRecord {
  shopId: string;
  sk: 'SETTINGS';
  paymentMethods: string[];
  customerTypes: string[];
  locale: string;
  theme: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const SETTINGS_TABLE = TABLES.ShopSettings as string;
const SETTINGS = SETTINGS_TABLE;

/** The row a brand-new shop starts with. Exported so it can be written inside
 *  the same transaction that creates the shop. */
export function buildDefaults(shopId: string): ShopSettingsRecord {
  const now = new Date().toISOString();
  return {
    shopId,
    sk: 'SETTINGS',
    paymentMethods: [...DEFAULT_PAYMENT_METHODS],
    customerTypes: [...DEFAULT_CUSTOMER_TYPES],
    locale: 'en',
    theme: {},
    createdAt: now,
    updatedAt: now,
  };
}

export async function create(shopId: string): Promise<ShopSettingsRecord> {
  const record = buildDefaults(shopId);
  await putItem(SETTINGS, record);
  return record;
}

/** Creates defaults on first read, matching the old self-healing behaviour. */
export async function getOrCreate(shopId: string): Promise<ShopSettingsRecord> {
  const existing = await getItem<ShopSettingsRecord>(SETTINGS, { shopId, sk: 'SETTINGS' });
  return existing ?? create(shopId);
}

export type SettingsPatch = Partial<Pick<ShopSettingsRecord, 'paymentMethods' | 'customerTypes' | 'locale' | 'theme'>>;

/** Upserts, so a shop predating settings still updates cleanly. */
export async function update(shopId: string, patch: SettingsPatch): Promise<ShopSettingsRecord> {
  const current = await getOrCreate(shopId);
  const next = { ...patch, updatedAt: new Date().toISOString() };
  await updateItem(SETTINGS, { shopId, sk: 'SETTINGS' }, next);
  return { ...current, ...next };
}

export async function remove(shopId: string): Promise<void> {
  const { deleteItem } = await import('./base.js');
  await deleteItem(SETTINGS, { shopId, sk: 'SETTINGS' });
}
