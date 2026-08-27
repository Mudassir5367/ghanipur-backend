import { Category } from '../../models/category.model.js';
import { Product } from '../../models/product.model.js';
import { tenantRepository } from '../../repositories/tenantRepository.js';
import { ApiError } from '../../utils/ApiError.js';
import { slugify, uniqueSlug } from '../../utils/slug.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateCategoryInput, UpdateCategoryInput } from './category.validators.js';

const repo = tenantRepository(Category);

async function assertParentExists(ctx: TenantContext, parentId?: string | null): Promise<void> {
  if (!parentId) return;
  const parent = await repo.findById(ctx, parentId);
  if (!parent || parent.isDeleted) throw ApiError.badRequest('Parent category not found', 'PARENT_NOT_FOUND');
}

async function assertNameFree(ctx: TenantContext, name: string, excludeId?: string): Promise<void> {
  // Case-insensitive duplicate-name guard per shop (§3).
  const filter: Record<string, unknown> = { name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), isDeleted: false };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await repo.exists(ctx, filter)) throw ApiError.conflict('A category with this name already exists', 'CATEGORY_EXISTS');
}

export async function createCategory(ctx: TenantContext, input: CreateCategoryInput) {
  await assertParentExists(ctx, input.parentId);
  await assertNameFree(ctx, input.name);
  const slug = await uniqueSlug(slugify(input.name), (s) => repo.exists(ctx, { slug: s, isDeleted: false }));
  return repo.create(ctx, { ...input, slug });
}

export async function listCategories(ctx: TenantContext, query: unknown, filters: { status?: string; parentId?: string }) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'sortOrder');
  const filter: Record<string, unknown> = { isDeleted: false };
  if (filters.status) filter.status = filters.status;
  if (filters.parentId) filter.parentId = filters.parentId;
  if (search) filter.name = { $regex: search, $options: 'i' };
  const { data, total } = await repo.paginate(ctx, filter, { skip, limit, sort });
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getCategory(ctx: TenantContext, id: string) {
  const category = await repo.findOne(ctx, { _id: id, isDeleted: false });
  if (!category) throw ApiError.notFound('Category not found', 'CATEGORY_NOT_FOUND');
  return category;
}

export async function updateCategory(ctx: TenantContext, id: string, input: UpdateCategoryInput) {
  await getCategory(ctx, id); // ensures shop-scoped existence
  if (input.parentId) {
    if (input.parentId === id) throw ApiError.badRequest('A category cannot be its own parent', 'INVALID_PARENT');
    await assertParentExists(ctx, input.parentId);
  }
  const update: Record<string, unknown> = { ...input };
  if (input.name) {
    await assertNameFree(ctx, input.name, id);
    update.slug = await uniqueSlug(slugify(input.name), (s) => repo.exists(ctx, { slug: s, isDeleted: false, _id: { $ne: id } }));
  }
  return repo.updateById(ctx, id, update);
}

export async function deleteCategory(ctx: TenantContext, id: string, userId: string) {
  await getCategory(ctx, id);
  const [childCount, productCount] = await Promise.all([
    repo.count(ctx, { parentId: id, isDeleted: false }),
    Product.countDocuments({ shopId: ctx.shopId, categoryId: id, isDeleted: false }),
  ]);
  if (childCount > 0) throw ApiError.conflict('Category has sub-categories', 'CATEGORY_HAS_CHILDREN');
  if (productCount > 0) throw ApiError.conflict('Category has products', 'CATEGORY_HAS_PRODUCTS');
  return repo.updateById(ctx, id, { isDeleted: true, deletedAt: new Date(), deletedBy: userId });
}
