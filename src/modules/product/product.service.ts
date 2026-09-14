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
import { recordMovement, undoMovements } from '../../services/inventory.service.js';
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
      // Average cost price across stock purchases — what sales are costed at.
      avgCostMinor: productRepo.averageCostMinor(p),
    };
  });
}

/** Stock purchases: every Stock In, plus opening-stock corrections (which change the opening purchase). */
function isPurchase(r: { type: string; refType: string; refId: string | null; productId: string }): boolean {
  return r.type === InventoryTxnType.STOCK_IN
    || (r.type === InventoryTxnType.ADJUSTMENT && r.refType === RefType.PRODUCT && r.refId === r.productId);
}

/**
 * For a product created before purchase costing (no running totals yet): its
 * earlier purchases, each costed at its recorded cost or else the product's Cost
 * Price, so the first costed purchase averages in the history rather than
 * ignoring it. Undefined for products that already keep totals.
 */
async function legacyPurchaseSeed(ctx: TenantContext, product: productRepo.ProductRecord) {
  if (product.costBasisQty !== undefined) return undefined;
  const rows = (await txnRepo.listByProduct(product.id)).filter((r) => r.shopId === ctx.shopId && isPurchase(r));
  return {
    qty: rows.reduce((s, r) => s + r.quantity, 0),
    costMinor: rows.reduce((s, r) => s + Math.round(r.quantity * (r.unitCostMinor ?? product.purchaseCostMinor)), 0),
  };
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
      supplier: input.supplier ?? '',
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

  // Opening stock becomes the first ledger entry (keeping cache = ledger) and the
  // first purchase: bought from the product's supplier at its Cost Price.
  if (input.openingStock && input.openingStock > 0 && (input.trackInventory ?? true)) {
    const moved = await recordMovement(ctx, {
      productId: product.id,
      type: InventoryTxnType.STOCK_IN,
      quantity: input.openingStock,
      refType: RefType.PRODUCT,
      refId: product.id,
      performedBy: userId,
      note: 'Opening stock',
      unitCostMinor: product.purchaseCostMinor,
      supplier: product.supplier,
    });
    if (!moved.skipped && moved.balanceAfter !== undefined) {
      const costMinor = Math.round(input.openingStock * product.purchaseCostMinor);
      try {
        await productRepo.addPurchaseCost(ctx.shopId, product.id, input.openingStock, costMinor);
      } catch (err) {
        if (moved.undo) await undoMovements(ctx, [moved.undo]);
        throw err;
      }
      product.currentStock = moved.balanceAfter;
      product.costBasisQty = input.openingStock;
      product.costBasisMinor = costMinor;
    }
  }

  return { ...product, avgCostMinor: productRepo.averageCostMinor(product) };
}

/** Distinct supplier/vendor names already used by the shop, for suggestions in the forms. */
export async function listSuppliers(ctx: TenantContext): Promise<string[]> {
  const [products, stockIns] = await Promise.all([
    productRepo.listByShop(ctx.shopId),
    txnRepo.listByShopType(ctx.shopId, InventoryTxnType.STOCK_IN),
  ]);
  const byKey = new Map<string, string>();
  for (const name of [...products.map((p) => p.supplier), ...stockIns.map((t) => t.supplier)]) {
    const trimmed = name?.trim();
    if (trimmed && !byKey.has(trimmed.toLowerCase())) byKey.set(trimmed.toLowerCase(), trimmed);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
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

/**
 * Opening stock is not a product field — it is the ledger movement(s) the product
 * references itself with (the initial STOCK_IN plus any later corrections).
 * Conversions also use RefType.PRODUCT but point at the *other* product, so
 * `refId === productId` isolates opening-stock rows.
 *
 * Reads the product's history from the base table (the same query the ledger
 * screen uses) rather than the byRef index, so rows written before `refKey`
 * existed are still counted.
 */
async function openingStockRows(ctx: TenantContext, productId: string) {
  const rows = await txnRepo.listByProduct(productId);
  return rows.filter((r) => r.shopId === ctx.shopId && r.refType === RefType.PRODUCT && r.refId === productId);
}

async function openingStockOf(ctx: TenantContext, productId: string): Promise<number> {
  return (await openingStockRows(ctx, productId)).reduce((sum, r) => sum + r.quantity, 0);
}

export async function getProduct(ctx: TenantContext, id: string) {
  const product = await productRepo.findById(ctx.shopId, id);
  if (!product) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  const [withRefs] = await attachRefs(ctx, [product]);
  return withRefs!;
}

/** GET /products/:id — the product plus its ledger-derived opening stock (edit form). */
export async function getProductDetail(ctx: TenantContext, id: string) {
  const product = await getProduct(ctx, id);
  return { ...product, openingStock: await openingStockOf(ctx, id) };
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

export async function updateProduct(ctx: TenantContext, id: string, input: UpdateProductInput, userId: string) {
  const existing = await productRepo.findById(ctx.shopId, id);
  if (!existing) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (input.categoryId) await assertCategory(ctx, input.categoryId);
  if (input.unitId) await assertUsableUnit(ctx, input.unitId);

  // openingStock is ledger-backed, never stored on the product row.
  const { sellingPrice: _s, purchaseCost: _p, taxRate: _tr, taxInclusive: _ti, openingStock, ...rest } = input;
  const patch = { ...rest, ...priceFields(input) } as productRepo.ProductPatch;

  // Correcting opening stock shifts current stock by the same difference. The ledger
  // is append-only, so the original entry stays and a correction is added beside it.
  let undo: Awaited<ReturnType<typeof recordMovement>>['undo'];
  let basisChange: { qty: number; costMinor: number } | undefined;
  if (openingStock !== undefined && existing.trackInventory) {
    const rows = await openingStockRows(ctx, id);
    const current = rows.reduce((sum, r) => sum + r.quantity, 0);
    const delta = openingStock - current;
    if (delta !== 0) {
      // A changed opening stock can never exceed the stock actually available.
      if (openingStock > existing.currentStock) {
        throw ApiError.badRequest('This much stock is not available. Please add stock first.', 'OPENING_STOCK_NOT_AVAILABLE');
      }
      // The correction changes the opening purchase, so it is costed like it.
      const openingUnitCost = rows.find((r) => r.type === InventoryTxnType.STOCK_IN)?.unitCostMinor ?? existing.purchaseCostMinor;
      try {
        const moved = await recordMovement(ctx, {
          productId: id,
          type: InventoryTxnType.ADJUSTMENT,
          quantity: delta,
          refType: RefType.PRODUCT,
          refId: id,
          performedBy: userId,
          note: `Opening stock corrected from ${current} to ${openingStock}`,
          allowNegative: false,
          unitCostMinor: openingUnitCost,
        });
        undo = moved.undo;
        // Products created before purchase costing have no totals to move yet; their
        // first costed purchase reads this correction from the ledger instead.
        if (!moved.skipped && existing.costBasisQty !== undefined) {
          basisChange = { qty: delta, costMinor: Math.round(delta * openingUnitCost) };
          try {
            await productRepo.addPurchaseCost(ctx.shopId, id, basisChange.qty, basisChange.costMinor);
          } catch (basisErr) {
            if (undo) await undoMovements(ctx, [undo]);
            throw basisErr;
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
          throw ApiError.badRequest(
            `Opening stock can't go below ${current - existing.currentStock}: only ${existing.currentStock} is left in stock after sales and deliveries.`,
            'OPENING_STOCK_TOO_LOW',
          );
        }
        throw err;
      }
    }
  }

  try {
    const updated = await productRepo.update(ctx.shopId, id, patch);
    if (!updated) return updated;
    const fresh = basisChange ? await productRepo.findById(ctx.shopId, id) : updated;
    return { ...updated, ...(fresh ? { costBasisQty: fresh.costBasisQty, costBasisMinor: fresh.costBasisMinor } : {}), avgCostMinor: productRepo.averageCostMinor(fresh ?? updated) };
  } catch (err) {
    // Don't leave a stock or cost change behind a failed save.
    if (basisChange) await productRepo.addPurchaseCost(ctx.shopId, id, -basisChange.qty, -basisChange.costMinor).catch(() => undefined);
    if (undo) await undoMovements(ctx, [undo]);
    throw err;
  }
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
  // A Stock In is a purchase: record who supplied it and its cost price, and fold
  // it into the product's average cost. Other movements (wastage, returns,
  // adjustments) are not purchases and leave the average alone.
  const isStockIn = input.type === InventoryTxnType.STOCK_IN;
  let purchase: { unitCostMinor: number; seed?: { qty: number; costMinor: number } } | undefined;
  if (isStockIn) {
    const before = await productRepo.findById(ctx.shopId, productId);
    if (!before) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
    purchase = {
      unitCostMinor: input.unitCost !== undefined ? toMinor(input.unitCost) : before.purchaseCostMinor,
      // Read before this purchase is written, so it isn't counted twice.
      seed: await legacyPurchaseSeed(ctx, before),
    };
  }

  const result = await recordMovement(ctx, {
    productId,
    type: input.type,
    quantity: input.quantity,
    refType: RefType.MANUAL,
    performedBy: userId,
    note: input.note,
    ...(purchase ? { unitCostMinor: purchase.unitCostMinor, supplier: input.supplier?.trim() || undefined } : {}),
  });

  if (purchase && !result.skipped) {
    const qty = Math.abs(input.quantity);
    try {
      await productRepo.addPurchaseCost(ctx.shopId, productId, qty, Math.round(qty * purchase.unitCostMinor), purchase.seed);
    } catch (err) {
      if (result.undo) await undoMovements(ctx, [result.undo]); // no stock without its cost
      throw err;
    }
  }

  // The response carries the resulting stock alongside the movement — the shape
  // the inventory screen reads.
  const product = await productRepo.findById(ctx.shopId, productId);
  return {
    movement: result,
    currentStock: product?.currentStock ?? 0,
    avgCostMinor: product ? productRepo.averageCostMinor(product) : 0,
  };
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
