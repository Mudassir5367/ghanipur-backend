import * as productRepo from '../../repositories/dynamo/productRepository.js';
import * as categoryRepo from '../../repositories/dynamo/categoryRepository.js';
import * as unitRepo from '../../repositories/dynamo/unitRepository.js';
import * as txnRepo from '../../repositories/dynamo/inventoryTransactionRepository.js';
import * as userRepo from '../../repositories/dynamo/userRepository.js';
import { UniqueConstraintError } from '../../repositories/dynamo/base.js';
import { ApiError } from '../../utils/ApiError.js';
import { slugify, uniqueSlug } from '../../utils/slug.js';
import { toMinor } from '../../utils/money.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { assertUsableUnit } from '../unit/unit.service.js';
import { recordMovement } from '../../services/inventory.service.js';
import { InventoryTxnType, RefType } from '../../constants/inventory.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateProductInput, UpdateProductInput, InventoryMovementInput } from './product.validators.js';

async function assertCategory(ctx: TenantContext, categoryId: string): Promise<void> {
  const category = await categoryRepo.findById(ctx.shopId, categoryId);
  if (!category) throw ApiError.badRequest('Category not found', 'CATEGORY_NOT_FOUND');
}

async function uniqueSku(ctx: TenantContext, name: string, provided?: string): Promise<string> {
  const base = (provided ?? slugify(name)).toUpperCase().replace(/-/g, '');
  return uniqueSlug(base, (s) => productRepo.skuExists(ctx.shopId, s));
}

/**
 * Suggest a clean, unique SKU like MILK-0001 (§4). Prefix derived from the
 * category name; sequence guaranteed free at time of suggestion (final
 * uniqueness is still enforced by the sku guard, so concurrent admins collide
 * safely rather than silently).
 */
export async function suggestSku(ctx: TenantContext, categoryId?: string): Promise<string> {
  let prefix = 'PRD';
  if (categoryId) {
    const cat = await categoryRepo.findById(ctx.shopId, categoryId);
    if (cat) {
      const letters = cat.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (letters) prefix = letters.slice(0, 4);
    }
  }
  const start = (await productRepo.listByShop(ctx.shopId)).length + 1;
  for (let n = start; n < start + 10000; n += 1) {
    const sku = `${prefix}-${String(n).padStart(4, '0')}`;
    if (!(await productRepo.skuExists(ctx.shopId, sku))) return sku;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Attaches the category and unit each product references.
 *
 * These were Mongoose `populate` calls. There is nothing to populate across in
 * DynamoDB, so the referenced rows are fetched once per distinct id on the page
 * and stitched in — the response shape is unchanged, so the frontend sees no
 * difference.
 */
async function attachRefs(ctx: TenantContext, rows: productRepo.ProductRecord[]) {
  const [cats, units] = await Promise.all([
    categoryRepo.listByShop(ctx.shopId),
    unitRepo.listForShop(ctx.shopId),
  ]);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const unitById = new Map(units.map((u) => [u.id, u]));
  return rows.map((p) => {
    const cat = catById.get(p.categoryId);
    const unit = unitById.get(p.unitId);
    return {
      ...p,
      categoryId: cat ? { _id: cat.id, name: cat.name, slug: cat.slug } : p.categoryId,
      unitId: unit ? { _id: unit.id, name: unit.name, symbol: unit.symbol } : p.unitId,
    };
  });
}

export async function createProduct(ctx: TenantContext, input: CreateProductInput, userId: string) {
  await assertCategory(ctx, input.categoryId);
  await assertUsableUnit(ctx, input.unitId);

  const slug = await uniqueSlug(slugify(input.name), (s) => productRepo.slugExists(ctx.shopId, s));
  const sku = await uniqueSku(ctx, input.name, input.sku);

  let product;
  try {
    product = await productRepo.create({
      shopId: ctx.shopId,
      categoryId: input.categoryId,
      unitId: input.unitId,
      name: input.name,
      slug,
      sku,
      description: input.description ?? '',
      images: input.images ?? [],
      unitValue: input.unitValue ?? 1,
      sellingPriceMinor: toMinor(input.sellingPrice),
      purchaseCostMinor: input.purchaseCost !== undefined ? toMinor(input.purchaseCost) : 0,
      taxConfig: { rate: input.taxRate ?? 0, inclusive: input.taxInclusive ?? true },
      minStock: input.minStock ?? 0,
      trackInventory: input.trackInventory ?? true,
      isAvailable: input.isAvailable ?? true,
      deliveryAvailable: input.deliveryAvailable ?? true,
      status: input.status,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw ApiError.conflict(`A product with this ${err.field} already exists`, 'PRODUCT_EXISTS');
    }
    throw err;
  }

  // Opening stock becomes the first ledger entry, keeping cache = ledger.
  if (input.openingStock && input.openingStock > 0 && (input.trackInventory ?? true)) {
    const moved = await recordMovement(ctx, {
      productId: product.id,
      type: InventoryTxnType.STOCK_IN,
      quantity: input.openingStock,
      refType: RefType.PRODUCT,
      refId: product.id,
      performedBy: userId,
      note: 'Opening stock',
    });
    if (!moved.skipped && moved.balanceAfter !== undefined) product.currentStock = moved.balanceAfter;
  }

  return product;
}

export async function listProducts(
  ctx: TenantContext,
  query: unknown,
  filters: { categoryId?: string; status?: string; isAvailable?: string; lowStock?: string },
) {
  const { page, limit, skip, sort, search } = parsePagination(query, '-createdAt');
  let rows = filters.categoryId
    ? await productRepo.listByCategory(ctx.shopId, filters.categoryId)
    : await productRepo.listByShop(ctx.shopId);

  if (filters.status) rows = rows.filter((p) => p.status === filters.status);
  if (filters.isAvailable) rows = rows.filter((p) => p.isAvailable === (filters.isAvailable === 'true'));
  if (filters.lowStock === 'true') rows = rows.filter((p) => p.currentStock <= p.minStock);

  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, { search, fields: (p) => [p.name, p.sku] });
  return { data: await attachRefs(ctx, data), meta: buildPageMeta(page, limit, total) };
}

export async function getProduct(ctx: TenantContext, id: string) {
  const product = await productRepo.findById(ctx.shopId, id);
  if (!product) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  const [withRefs] = await attachRefs(ctx, [product]);
  return withRefs!;
}

/** Map API money (rupees) fields onto stored *Minor fields. */
function priceFields(input: Partial<CreateProductInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.sellingPrice !== undefined) out.sellingPriceMinor = toMinor(input.sellingPrice);
  if (input.purchaseCost !== undefined) out.purchaseCostMinor = toMinor(input.purchaseCost);
  if (input.taxRate !== undefined || input.taxInclusive !== undefined) {
    out.taxConfig = { rate: input.taxRate ?? 0, inclusive: input.taxInclusive ?? true };
  }
  return out;
}

export async function updateProduct(ctx: TenantContext, id: string, input: UpdateProductInput) {
  const existing = await productRepo.findById(ctx.shopId, id);
  if (!existing) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (input.categoryId) await assertCategory(ctx, input.categoryId);
  if (input.unitId) await assertUsableUnit(ctx, input.unitId);

  const { sellingPrice: _s, purchaseCost: _p, taxRate: _tr, taxInclusive: _ti, ...rest } = input;
  const patch = { ...rest, ...priceFields(input) } as productRepo.ProductPatch;
  return productRepo.update(ctx.shopId, id, patch);
}

export async function deleteProduct(ctx: TenantContext, id: string, userId: string) {
  const product = await productRepo.findById(ctx.shopId, id);
  if (!product) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  await productRepo.update(ctx.shopId, id, { isAvailable: false });
  return productRepo.softDelete(ctx.shopId, id, userId);
}

// ---- Inventory ----
export async function recordInventoryMovement(
  ctx: TenantContext,
  productId: string,
  input: InventoryMovementInput,
  userId: string,
) {
  const result = await recordMovement(ctx, {
    productId,
    type: input.type,
    quantity: input.quantity,
    refType: RefType.MANUAL,
    performedBy: userId,
    note: input.note,
  });
  // The response carries the resulting stock alongside the movement — the shape
  // the inventory screen reads.
  const product = await productRepo.findById(ctx.shopId, productId);
  return { movement: result, currentStock: product?.currentStock ?? 0 };
}

export async function getProductLedger(ctx: TenantContext, productId: string, query: unknown) {
  await getProduct(ctx, productId); // ensures shop scope
  const { page, limit, skip, sort } = parsePagination(query, '-occurredAt');
  const rows = (await txnRepo.listByProduct(productId)).filter((t) => t.shopId === ctx.shopId);
  const { data, total } = paginateInMemory(rows, { skip, limit, sort });

  // `performedBy` was a Mongoose populate; users live in their own store now, so
  // resolve names explicitly — one lookup per distinct actor on the page.
  const actorIds = [...new Set(data.map((r) => r.performedBy).filter((v): v is string => !!v))];
  const actors = await Promise.all(actorIds.map((id) => userRepo.findById(id)));
  const nameById = new Map(actors.filter((u) => u !== null).map((u) => [u.id, u.name]));

  return {
    data: data.map((row) => ({
      ...row,
      performedBy: row.performedBy ? { _id: row.performedBy, name: nameById.get(row.performedBy) ?? null } : null,
    })),
    meta: buildPageMeta(page, limit, total),
  };
}
