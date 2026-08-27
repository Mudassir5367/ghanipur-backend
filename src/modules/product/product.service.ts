import { Product } from '../../models/product.model.js';
import { Category } from '../../models/category.model.js';
import { InventoryTransaction } from '../../models/inventoryTransaction.model.js';
import { tenantRepository } from '../../repositories/tenantRepository.js';
import { ApiError } from '../../utils/ApiError.js';
import { slugify, uniqueSlug } from '../../utils/slug.js';
import { toMinor } from '../../utils/money.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { assertUsableUnit } from '../unit/unit.service.js';
import { recordMovement } from '../../services/inventory.service.js';
import { InventoryTxnType, RefType } from '../../constants/inventory.js';
import { withTransaction } from '../../utils/withTransaction.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateProductInput, UpdateProductInput, InventoryMovementInput } from './product.validators.js';

const repo = tenantRepository(Product);

async function assertCategory(ctx: TenantContext, categoryId: string): Promise<void> {
  const category = await Category.findOne({ _id: categoryId, shopId: ctx.shopId, isDeleted: false });
  if (!category) throw ApiError.badRequest('Category not found', 'CATEGORY_NOT_FOUND');
}

async function uniqueSku(ctx: TenantContext, name: string, provided?: string): Promise<string> {
  const base = (provided ?? slugify(name)).toUpperCase().replace(/-/g, '');
  return uniqueSlug(base, (s) => repo.exists(ctx, { sku: s }));
}

/**
 * Suggest a clean, unique SKU like MILK-0001 (§4). Prefix derived from the
 * category name; sequence guaranteed free at time of suggestion (final
 * uniqueness is still enforced on create, so concurrent admins can't collide).
 */
export async function suggestSku(ctx: TenantContext, categoryId?: string): Promise<string> {
  let prefix = 'PRD';
  if (categoryId) {
    const cat = await Category.findOne({ _id: categoryId, shopId: ctx.shopId, isDeleted: false });
    if (cat) {
      const letters = cat.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (letters) prefix = letters.slice(0, 4);
    }
  }
  const start = (await repo.count(ctx, {})) + 1;
  for (let n = start; n < start + 10000; n += 1) {
    const sku = `${prefix}-${String(n).padStart(4, '0')}`;
    if (!(await repo.exists(ctx, { sku }))) return sku;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
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

export async function createProduct(ctx: TenantContext, input: CreateProductInput, userId: string) {
  await assertCategory(ctx, input.categoryId);
  await assertUsableUnit(ctx, input.unitId);

  const slug = await uniqueSlug(slugify(input.name), (s) => repo.exists(ctx, { slug: s }));
  const sku = await uniqueSku(ctx, input.name, input.sku);

  return withTransaction(async (session) => {
    const [product] = await Product.create(
      [{
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
      }],
      { session },
    );

    // Opening stock becomes the first ledger entry, keeping cache = ledger.
    if (input.openingStock && input.openingStock > 0 && (input.trackInventory ?? true)) {
      await recordMovement(
        ctx,
        {
          productId: product!._id.toString(),
          type: InventoryTxnType.STOCK_IN,
          quantity: input.openingStock,
          refType: RefType.PRODUCT,
          refId: product!._id,
          performedBy: userId,
          note: 'Opening stock',
        },
        session,
      );
      product!.currentStock = input.openingStock;
    }

    return product!;
  });
}

export async function listProducts(ctx: TenantContext, query: unknown, filters: { categoryId?: string; status?: string; isAvailable?: string; lowStock?: string }) {
  const { page, limit, skip, sort, search } = parsePagination(query, '-createdAt');
  const filter: Record<string, unknown> = repo.scoped(ctx, { isDeleted: false });
  if (filters.categoryId) filter.categoryId = filters.categoryId;
  if (filters.status) filter.status = filters.status;
  if (filters.isAvailable) filter.isAvailable = filters.isAvailable === 'true';
  if (filters.lowStock === 'true') filter.$expr = { $lte: ['$currentStock', '$minStock'] };
  if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { sku: { $regex: search, $options: 'i' } }];

  const [data, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(limit).populate('categoryId', 'name slug').populate('unitId', 'name symbol'),
    Product.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getProduct(ctx: TenantContext, id: string) {
  const product = await Product.findOne(repo.scoped(ctx, { _id: id, isDeleted: false }))
    .populate('categoryId', 'name slug')
    .populate('unitId', 'name symbol');
  if (!product) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  return product;
}

export async function updateProduct(ctx: TenantContext, id: string, input: UpdateProductInput) {
  const existing = await repo.findById(ctx, id);
  if (!existing || existing.isDeleted) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (input.categoryId) await assertCategory(ctx, input.categoryId);
  if (input.unitId) await assertUsableUnit(ctx, input.unitId);

  const { sellingPrice: _s, purchaseCost: _p, taxRate: _tr, taxInclusive: _ti, ...rest } = input;
  const update: Record<string, unknown> = { ...rest, ...priceFields(input) };
  delete (update as { openingStock?: unknown }).openingStock;

  return repo.updateById(ctx, id, update);
}

export async function deleteProduct(ctx: TenantContext, id: string, userId: string) {
  const product = await repo.findById(ctx, id);
  if (!product || product.isDeleted) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  return repo.updateById(ctx, id, { isDeleted: true, deletedAt: new Date(), deletedBy: userId, isAvailable: false });
}

// ---- Inventory ----
export async function recordInventoryMovement(ctx: TenantContext, productId: string, input: InventoryMovementInput, userId: string) {
  const result = await recordMovement(ctx, {
    productId,
    type: input.type,
    quantity: input.quantity,
    refType: RefType.MANUAL,
    performedBy: userId,
    note: input.note,
  });
  const product = await repo.findById(ctx, productId, 'currentStock name');
  return { movement: result, currentStock: product?.currentStock ?? 0 };
}

export async function getProductLedger(ctx: TenantContext, productId: string, query: unknown) {
  await getProduct(ctx, productId); // ensures shop scope
  const { page, limit, skip } = parsePagination(query, '-occurredAt');
  const filter = { shopId: ctx.shopId, productId };
  const [data, total] = await Promise.all([
    InventoryTransaction.find(filter).sort({ occurredAt: -1 }).skip(skip).limit(limit).populate('performedBy', 'name'),
    InventoryTransaction.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}
