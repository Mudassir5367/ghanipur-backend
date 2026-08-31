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
 * DynamoDB-backed Category store, replacing the Mongoose `Category` model.
 *
 * Layout: {shopId, id}, so every read is naturally tenant-scoped (§22). The
 * `{shopId, slug}` unique index becomes CategorySlugGuard, and `bySlug` /
 * `byParent` cover storefront lookups and the nested-category tree.
 */

export const CategoryStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type CategoryStatus = (typeof CategoryStatus)[keyof typeof CategoryStatus];

export interface CategoryRecord {
  shopId: string;
  id: string;
  _id?: string;
  shopSlugKey: string;
  /** "<shopId>#<parentId|ROOT>" — the byParent partition for the tree. */
  shopParentKey: string;
  /** Zero-padded so lexical sort-key order matches numeric sortOrder. */
  sortOrderKey: string;
  name: string;
  slug: string;
  description: string;
  image: string | null;
  icon: string | null;
  parentId: string | null;
  sortOrder: number;
  status: CategoryStatus;
  seoTitle: string;
  seoDescription: string;
  isDeleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = TABLES.Category as string;
const SLUG_GUARD = TABLES.CategorySlugGuard as string;

const ROOT = 'ROOT';
const parentKey = (shopId: string, parentId: string | null): string => compositeKey(shopId, parentId ?? ROOT);
const orderKey = (sortOrder: number, id: string): string => `${String(sortOrder).padStart(6, '0')}#${id}`;

function slugGuard(shopId: string, slug: string): GuardSpec {
  return {
    table: SLUG_GUARD,
    key: { shopSlugKey: compositeKey(shopId, slug), sk: 'GUARD' },
    pkName: 'shopSlugKey',
    field: 'slug',
  };
}

export async function findById(shopId: string, id: string): Promise<CategoryRecord | null> {
  const row = await getItem<CategoryRecord>(CATEGORIES, { shopId, id });
  return row && !row.isDeleted ? withLegacyId(row) : null;
}

export async function findBySlug(shopId: string, slug: string): Promise<CategoryRecord | null> {
  const row = await queryOneByIndex<CategoryRecord>(CATEGORIES, 'bySlug', 'shopSlugKey', compositeKey(shopId, slug));
  return row && !row.isDeleted ? withLegacyId(row) : null;
}

export async function slugExists(shopId: string, slug: string): Promise<boolean> {
  return (await getItem(SLUG_GUARD, { shopSlugKey: compositeKey(shopId, slug), sk: 'GUARD' })) !== null;
}

/** Live categories for a shop. Soft-deleted rows are filtered here, as Mongo did. */
export async function listByShop(shopId: string): Promise<CategoryRecord[]> {
  const rows = await queryAllByPartition<CategoryRecord>(CATEGORIES, 'shopId', shopId);
  return rows.filter((c) => !c.isDeleted).map((c) => withLegacyId(c));
}

export async function listChildren(shopId: string, parentId: string | null): Promise<CategoryRecord[]> {
  const rows = await queryAllByPartition<CategoryRecord>(CATEGORIES, 'shopParentKey', parentKey(shopId, parentId), {
    indexName: 'byParent',
  });
  return rows.filter((c) => !c.isDeleted).map((c) => withLegacyId(c));
}

export interface CreateCategoryInput {
  shopId: string;
  name: string;
  slug: string;
  description?: string;
  image?: string | null;
  icon?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  status?: CategoryStatus;
  seoTitle?: string;
  seoDescription?: string;
}

/** Throws UniqueConstraintError('slug') when the shop already uses it. */
export async function create(input: CreateCategoryInput): Promise<CategoryRecord> {
  const now = new Date().toISOString();
  const id = newId();
  const sortOrder = input.sortOrder ?? 0;
  const record: CategoryRecord = {
    shopId: input.shopId,
    id,
    shopSlugKey: compositeKey(input.shopId, input.slug),
    shopParentKey: parentKey(input.shopId, input.parentId ?? null),
    sortOrderKey: orderKey(sortOrder, id),
    name: input.name,
    slug: input.slug,
    description: input.description ?? '',
    image: input.image ?? null,
    icon: input.icon ?? null,
    parentId: input.parentId ?? null,
    sortOrder,
    status: input.status ?? CategoryStatus.ACTIVE,
    seoTitle: input.seoTitle ?? '',
    seoDescription: input.seoDescription ?? '',
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await putWithGuards(CATEGORIES, record, [slugGuard(input.shopId, input.slug)]);
  return withLegacyId(record);
}

/** Bulk create for shop provisioning — each row still guards its own slug. */
export async function createMany(inputs: CreateCategoryInput[]): Promise<CategoryRecord[]> {
  const out: CategoryRecord[] = [];
  for (const input of inputs) out.push(await create(input));
  return out;
}

export type CategoryPatch = Partial<
  Pick<
    CategoryRecord,
    'name' | 'description' | 'image' | 'icon' | 'parentId' | 'sortOrder' | 'status' | 'seoTitle' | 'seoDescription'
  >
>;

export async function update(shopId: string, id: string, patch: CategoryPatch): Promise<CategoryRecord | null> {
  const current = await findById(shopId, id);
  if (!current) return null;
  const next: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
  // Both derived keys must follow their source fields or the tree query breaks.
  if (patch.parentId !== undefined) next.shopParentKey = parentKey(shopId, patch.parentId ?? null);
  if (patch.sortOrder !== undefined) next.sortOrderKey = orderKey(patch.sortOrder, id);
  await updateItem(CATEGORIES, { shopId, id }, next);
  return withLegacyId({ ...current, ...next } as CategoryRecord);
}

/** Soft delete, releasing the slug so the shop can reuse the name. */
export async function softDelete(shopId: string, id: string, deletedBy: string): Promise<CategoryRecord | null> {
  const current = await findById(shopId, id);
  if (!current) return null;
  const now = new Date().toISOString();
  await updateItem(CATEGORIES, { shopId, id }, { isDeleted: true, deletedAt: now, deletedBy, updatedAt: now });
  await releaseGuard(slugGuard(shopId, current.slug));
  return withLegacyId({ ...current, isDeleted: true, deletedAt: now, deletedBy });
}

/** Hard delete — seed/test teardown only. */
export async function hardDelete(shopId: string, id: string, slug: string): Promise<void> {
  await deleteItem(CATEGORIES, { shopId, id });
  await releaseGuard(slugGuard(shopId, slug));
}
