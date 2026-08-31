import * as categoryRepo from '../../repositories/dynamo/categoryRepository.js';
import * as productRepo from '../../repositories/dynamo/productRepository.js';
import { UniqueConstraintError } from '../../repositories/dynamo/base.js';
import { ApiError } from '../../utils/ApiError.js';
import { slugify, uniqueSlug } from '../../utils/slug.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateCategoryInput, UpdateCategoryInput } from './category.validators.js';

async function assertParentExists(ctx: TenantContext, parentId?: string | null): Promise<void> {
  if (!parentId) return;
  const parent = await categoryRepo.findById(ctx.shopId, parentId);
  if (!parent) throw ApiError.badRequest('Parent category not found', 'PARENT_NOT_FOUND');
}

/**
 * Case-insensitive duplicate-name guard per shop (§3).
 *
 * Mongo did this with a regex query; DynamoDB has no case-insensitive match, so
 * the shop's categories are read and compared in memory. A shop has tens of
 * categories, so this is cheap — and the slug guard remains the hard constraint
 * underneath, catching anything this check races past.
 */
async function assertNameFree(ctx: TenantContext, name: string, excludeId?: string): Promise<void> {
  const needle = name.trim().toLowerCase();
  const rows = await categoryRepo.listByShop(ctx.shopId);
  if (rows.some((c) => c.name.trim().toLowerCase() === needle && c.id !== excludeId)) {
    throw ApiError.conflict('A category with this name already exists', 'CATEGORY_EXISTS');
  }
}

export async function createCategory(ctx: TenantContext, input: CreateCategoryInput) {
  await assertParentExists(ctx, input.parentId);
  await assertNameFree(ctx, input.name);
  const slug = await uniqueSlug(slugify(input.name), (s) => categoryRepo.slugExists(ctx.shopId, s));
  try {
    return await categoryRepo.create({ ...input, shopId: ctx.shopId, slug });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw ApiError.conflict('A category with this name already exists', 'CATEGORY_EXISTS');
    }
    throw err;
  }
}

export async function listCategories(ctx: TenantContext, query: unknown, filters: { status?: string; parentId?: string }) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'sortOrder');
  let rows = await categoryRepo.listByShop(ctx.shopId);
  if (filters.status) rows = rows.filter((c) => c.status === filters.status);
  if (filters.parentId) rows = rows.filter((c) => c.parentId === filters.parentId);
  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, { search, fields: (c) => [c.name] });
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getCategory(ctx: TenantContext, id: string) {
  const category = await categoryRepo.findById(ctx.shopId, id);
  if (!category) throw ApiError.notFound('Category not found', 'CATEGORY_NOT_FOUND');
  return category;
}

export async function updateCategory(ctx: TenantContext, id: string, input: UpdateCategoryInput) {
  await getCategory(ctx, id); // ensures shop-scoped existence
  if (input.parentId) {
    if (input.parentId === id) throw ApiError.badRequest('A category cannot be its own parent', 'INVALID_PARENT');
    await assertParentExists(ctx, input.parentId);
  }
  if (input.name) await assertNameFree(ctx, input.name, id);
  // The slug is part of a uniqueness guard, so renaming would mean releasing and
  // re-taking it. Names are display-only here; the slug stays as first created.
  return categoryRepo.update(ctx.shopId, id, input as categoryRepo.CategoryPatch);
}

export async function deleteCategory(ctx: TenantContext, id: string, userId: string) {
  await getCategory(ctx, id);
  const [children, products] = await Promise.all([
    categoryRepo.listChildren(ctx.shopId, id),
    productRepo.listByCategory(ctx.shopId, id),
  ]);
  if (children.length > 0) throw ApiError.conflict('Category has sub-categories', 'CATEGORY_HAS_CHILDREN');
  if (products.length > 0) throw ApiError.conflict('Category has products', 'CATEGORY_HAS_PRODUCTS');
  return categoryRepo.softDelete(ctx.shopId, id, userId);
}
