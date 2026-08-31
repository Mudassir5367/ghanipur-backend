import { TABLES } from '../../config/dynamoTables.js';
import {
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

/**
 * DynamoDB-backed Unit store, replacing the Mongoose `Unit` model.
 *
 * Units are either platform-shared or shop-specific (§7). Mongo modelled that
 * with `shopId: null`; DynamoDB cannot have a null partition key, so shared
 * units live under the literal partition "PLATFORM" and shop units under their
 * shopId. The `{shopId, symbol}` unique index becomes UnitSymbolGuard.
 */

export const UnitKind = { VOLUME: 'VOLUME', WEIGHT: 'WEIGHT', COUNT: 'COUNT', CUSTOM: 'CUSTOM' } as const;
export type UnitKind = (typeof UnitKind)[keyof typeof UnitKind];

export const PLATFORM = 'PLATFORM';

export interface UnitRecord {
  shopKey: string;
  id: string;
  _id?: string;
  /** null for platform-shared units, mirroring the old schema. */
  shopId: string | null;
  shopSymbolKey: string;
  name: string;
  symbol: string;
  kind: UnitKind;
  allowsDecimal: boolean;
  isShared: boolean;
  createdAt: string;
  updatedAt: string;
}

const UNITS = TABLES.Unit as string;
const SYMBOL_GUARD = TABLES.UnitSymbolGuard as string;

const keyFor = (shopId: string | null): string => shopId ?? PLATFORM;

function symbolGuard(shopId: string | null, symbol: string): GuardSpec {
  return {
    table: SYMBOL_GUARD,
    key: { shopSymbolKey: compositeKey(keyFor(shopId), symbol), sk: 'GUARD' },
    pkName: 'shopSymbolKey',
    field: 'symbol',
  };
}

export async function findById(shopId: string | null, id: string): Promise<UnitRecord | null> {
  return withLegacyId(await getItem<UnitRecord>(UNITS, { shopKey: keyFor(shopId), id }));
}

/**
 * A unit usable by this shop: its own, or a platform-shared one. Mongo expressed
 * this as `{shopId: {$in: [shopId, null]}}`; here it is two point reads.
 */
export async function findUsable(shopId: string, id: string): Promise<UnitRecord | null> {
  return (await findById(shopId, id)) ?? (await findById(null, id));
}

export async function findBySymbol(shopId: string | null, symbol: string): Promise<UnitRecord | null> {
  return withLegacyId(
    await queryOneByIndex<UnitRecord>(UNITS, 'bySymbol', 'shopSymbolKey', compositeKey(keyFor(shopId), symbol)),
  );
}

export async function listPlatform(): Promise<UnitRecord[]> {
  const rows = await queryAllByPartition<UnitRecord>(UNITS, 'shopKey', PLATFORM);
  return rows.map((r) => withLegacyId(r));
}

export async function listForShop(shopId: string): Promise<UnitRecord[]> {
  const [own, shared] = await Promise.all([
    queryAllByPartition<UnitRecord>(UNITS, 'shopKey', shopId),
    listPlatform(),
  ]);
  return [...shared, ...own.map((r) => withLegacyId(r))];
}

export interface CreateUnitInput {
  shopId: string | null;
  name: string;
  symbol: string;
  kind?: UnitKind;
  allowsDecimal?: boolean;
  isShared?: boolean;
}

/** Throws UniqueConstraintError('symbol') when the shop already uses it. */
export async function create(input: CreateUnitInput): Promise<UnitRecord> {
  const now = new Date().toISOString();
  const record: UnitRecord = {
    shopKey: keyFor(input.shopId),
    id: newId(),
    shopId: input.shopId,
    shopSymbolKey: compositeKey(keyFor(input.shopId), input.symbol),
    name: input.name,
    symbol: input.symbol,
    kind: input.kind ?? UnitKind.CUSTOM,
    allowsDecimal: input.allowsDecimal ?? true,
    isShared: input.isShared ?? input.shopId === null,
    createdAt: now,
    updatedAt: now,
  };
  await putWithGuards(UNITS, record, [symbolGuard(input.shopId, input.symbol)]);
  return withLegacyId(record);
}

export type UnitPatch = Partial<Pick<UnitRecord, 'name' | 'kind' | 'allowsDecimal'>>;

export async function update(shopId: string | null, id: string, patch: UnitPatch): Promise<UnitRecord | null> {
  const current = await findById(shopId, id);
  if (!current) return null;
  const next = { ...patch, updatedAt: new Date().toISOString() };
  await updateItem(UNITS, { shopKey: keyFor(shopId), id }, next);
  return withLegacyId({ ...current, ...next });
}

export async function remove(shopId: string | null, id: string): Promise<void> {
  const current = await findById(shopId, id);
  if (!current) return;
  await deleteItem(UNITS, { shopKey: keyFor(shopId), id });
  await releaseGuard(symbolGuard(shopId, current.symbol));
}
