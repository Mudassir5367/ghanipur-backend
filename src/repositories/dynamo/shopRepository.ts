import { TABLES } from '../../config/dynamoTables.js';
import {
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
 * DynamoDB-backed Shop store, replacing the Mongoose `Shop` model.
 *
 * Layout: one item per shop at {id, sk:"META"}, with `bySlug` for the public
 * storefront and `byStatus` for admin listings. Two Mongo unique indexes become
 * guard tables written in the same transaction as the shop:
 *   - slug        -> ShopSlugGuard
 *   - ownerId     -> ShopOwnerGuard, which enforced "one active shop per admin"
 *                    as a partial unique index. Soft-deleting a shop releases
 *                    the guard, so the owner can create another — matching the
 *                    partialFilterExpression the Mongo index used.
 */

export const ShopStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  INACTIVE: 'INACTIVE',
} as const;
export type ShopStatus = (typeof ShopStatus)[keyof typeof ShopStatus];

export interface ShopAddress {
  line: string;
  city: string;
  area: string;
  geo?: { lat?: number; lng?: number };
}

export interface DeliverySettings {
  enabled: boolean;
  feeMinor: number;
  minOrderMinor: number;
  radiusKm: number;
}

export interface ShopRecord {
  id: string;
  /** Alias of `id`, added on read — the REST contract and frontend say `_id`. */
  _id?: string;
  sk: 'META';
  name: string;
  slug: string;
  ownerId: string;
  logo: string | null;
  banner: string | null;
  description: string;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address: ShopAddress;
  businessHours: Record<string, unknown>;
  socialLinks: Record<string, unknown>;
  timezone: string;
  currency: string;
  deliverySettings: DeliverySettings;
  status: ShopStatus;
  /** "<status>#<0|1>" — the byStatus partition, so admin lists stay a Query. */
  statusDeletedKey: string;
  isDeleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const SHOPS = TABLES.Shop as string;
const SLUG_GUARD = TABLES.ShopSlugGuard as string;
const OWNER_GUARD = TABLES.ShopOwnerGuard as string;

const statusKey = (status: ShopStatus, isDeleted: boolean): string => `${status}#${isDeleted ? 1 : 0}`;

function slugGuard(slug: string): GuardSpec {
  return { table: SLUG_GUARD, key: { slug, sk: 'GUARD' }, pkName: 'slug', field: 'slug' };
}

function ownerGuard(ownerId: string): GuardSpec {
  return { table: OWNER_GUARD, key: { ownerId, sk: 'GUARD' }, pkName: 'ownerId', field: 'ownerId' };
}

export async function findById(id: string): Promise<ShopRecord | null> {
  const shop = await getItem<ShopRecord>(SHOPS, { id, sk: 'META' });
  return shop && !shop.isDeleted ? withLegacyId(shop) : null;
}

/** Includes soft-deleted shops — only for admin/audit paths that need them. */
export async function findByIdIncludingDeleted(id: string): Promise<ShopRecord | null> {
  return withLegacyId(await getItem<ShopRecord>(SHOPS, { id, sk: 'META' }));
}

export async function findBySlug(slug: string): Promise<ShopRecord | null> {
  const shop = await queryOneByIndex<ShopRecord>(SHOPS, 'bySlug', 'slug', slug);
  return shop && !shop.isDeleted ? withLegacyId(shop) : null;
}

export async function slugExists(slug: string): Promise<boolean> {
  return (await getItem(SLUG_GUARD, { slug, sk: 'GUARD' })) !== null;
}

export interface CreateShopRecord {
  name: string;
  slug: string;
  ownerId: string;
  phone?: string | null;
  status?: ShopStatus;
}

/**
 * Throws UniqueConstraintError('slug' | 'ownerId') when either guard is taken.
 * `alsoPut` rows land in the same transaction — used for the shop's settings, so
 * a shop can never exist without them.
 */
export async function create(
  input: CreateShopRecord,
  alsoPut: (shopId: string) => { table: string; item: object }[] = () => [],
): Promise<ShopRecord> {
  const now = new Date().toISOString();
  const status = input.status ?? ShopStatus.PENDING;
  const record: ShopRecord = {
    id: newId(),
    sk: 'META',
    name: input.name,
    slug: input.slug,
    ownerId: input.ownerId,
    logo: null,
    banner: null,
    description: '',
    phone: input.phone ?? null,
    whatsapp: null,
    email: null,
    address: { line: '', city: '', area: '' },
    businessHours: {},
    socialLinks: {},
    timezone: 'Asia/Karachi',
    currency: 'PKR',
    deliverySettings: { enabled: true, feeMinor: 0, minOrderMinor: 0, radiusKm: 0 },
    status,
    statusDeletedKey: statusKey(status, false),
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await putWithGuards(SHOPS, record, [slugGuard(input.slug), ownerGuard(input.ownerId)], alsoPut(record.id));
  return withLegacyId(record);
}

export type ShopPatch = Partial<Omit<ShopRecord, 'id' | 'sk' | 'slug' | 'ownerId' | 'createdAt'>>;

export async function update(id: string, patch: ShopPatch): Promise<ShopRecord | null> {
  const current = await findById(id);
  if (!current) return null;
  const next = { ...patch, updatedAt: new Date().toISOString() } as ShopPatch;
  // statusDeletedKey is derived; keep it consistent whenever status changes.
  if (patch.status !== undefined) {
    next.statusDeletedKey = statusKey(patch.status, current.isDeleted);
  }
  await updateItem(SHOPS, { id, sk: 'META' }, next as Record<string, unknown>);
  return withLegacyId({ ...current, ...next } as ShopRecord);
}

export async function setStatus(id: string, status: ShopStatus): Promise<ShopRecord | null> {
  return update(id, { status });
}

/**
 * Soft-deletes and releases the owner guard so the admin can create a new shop,
 * mirroring the Mongo partial unique index. The slug guard is kept: a deleted
 * shop's storefront URL must not be reusable by someone else.
 */
export async function softDelete(id: string, deletedBy: string): Promise<ShopRecord | null> {
  const current = await findById(id);
  if (!current) return null;
  const patch = {
    isDeleted: true,
    deletedAt: new Date().toISOString(),
    deletedBy,
    statusDeletedKey: statusKey(current.status, true),
    updatedAt: new Date().toISOString(),
  };
  await updateItem(SHOPS, { id, sk: 'META' }, patch);
  await releaseGuard(ownerGuard(current.ownerId));
  return withLegacyId({ ...current, ...patch } as ShopRecord);
}

/** Every non-deleted shop with the given status, via the byStatus index. */
export async function listByStatus(status: ShopStatus): Promise<ShopRecord[]> {
  const rows = await queryAllByPartition<ShopRecord>(SHOPS, 'statusDeletedKey', statusKey(status, false), {
    indexName: 'byStatus',
  });
  return rows.map((r) => withLegacyId(r));
}

/** Every live shop, across all statuses — admin listing. */
export async function listAllActive(): Promise<ShopRecord[]> {
  const perStatus = await Promise.all(Object.values(ShopStatus).map((s) => listByStatus(s)));
  return perStatus.flat();
}

/** Hard delete — compensation only (a failed multi-store create). */
export async function hardDelete(shop: Pick<ShopRecord, 'id' | 'slug' | 'ownerId'>): Promise<void> {
  await deleteItem(SHOPS, { id: shop.id, sk: 'META' });
  await releaseGuard(slugGuard(shop.slug));
  await releaseGuard(ownerGuard(shop.ownerId));
}
