import * as shopRepo from '../../repositories/dynamo/shopRepository.js';
import { ShopStatus } from '../../repositories/dynamo/shopRepository.js';
import * as categoryRepo from '../../repositories/dynamo/categoryRepository.js';
import { CategoryStatus } from '../../repositories/dynamo/categoryRepository.js';
import * as productRepo from '../../repositories/dynamo/productRepository.js';
import * as unitRepo from '../../repositories/dynamo/unitRepository.js';
import { ApiError } from '../../utils/ApiError.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';

async function resolveActiveShop(slug: string) {
  const shop = await shopRepo.findBySlug(slug);
  if (!shop || shop.status !== ShopStatus.ACTIVE) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

/** Storefront-safe projection — never leak internal or owner fields (§32). */
function toPublicShop(shop: shopRepo.ShopRecord) {
  const { id, name, slug, logo, banner, description, address, phone, whatsapp } = shop;
  return { _id: id, id, name, slug, logo, banner, description, address, phone, whatsapp };
}

/**
 * Public product projection — never expose purchase cost or internal fields (§32).
 * Mongo did this with a field-list string; here the shape is built explicitly,
 * which makes the omission of purchaseCostMinor impossible to lose by accident.
 */
function toPublicProduct(
  product: productRepo.ProductRecord,
  category?: { id: string; name: string; slug: string },
  unit?: { id: string; name: string; symbol: string },
) {
  return {
    _id: product.id,
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    images: product.images,
    sellingPriceMinor: product.sellingPriceMinor,
    unitValue: product.unitValue,
    currentStock: product.currentStock,
    trackInventory: product.trackInventory,
    isAvailable: product.isAvailable,
    categoryId: category ? { _id: category.id, name: category.name, slug: category.slug } : product.categoryId,
    unitId: unit ? { _id: unit.id, name: unit.name, symbol: unit.symbol } : product.unitId,
  };
}

async function refLookups(shopId: string) {
  const [cats, units] = await Promise.all([categoryRepo.listByShop(shopId), unitRepo.listForShop(shopId)]);
  return {
    catById: new Map(cats.map((c) => [c.id, c])),
    unitById: new Map(units.map((u) => [u.id, u])),
  };
}

export async function listShops(query: unknown) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'name');
  const rows = await shopRepo.listByStatus(ShopStatus.ACTIVE);
  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, { search, fields: (s) => [s.name] });
  return { data: data.map(toPublicShop), meta: buildPageMeta(page, limit, total) };
}

export async function getShop(slug: string) {
  const shop = await resolveActiveShop(slug);
  const categories = (await categoryRepo.listByShop(shop.id))
    .filter((c) => c.status === CategoryStatus.ACTIVE)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => ({ _id: c.id, name: c.name, slug: c.slug, image: c.image, icon: c.icon, sortOrder: c.sortOrder }));
  return { shop, categories };
}

export async function listProducts(slug: string, query: unknown, filters: { categoryId?: string; search?: string }) {
  const shop = await resolveActiveShop(slug);
  const { page, limit, skip, sort } = parsePagination(query, '-createdAt');

  // The byStatus index already restricts to ACTIVE + available products.
  let rows = await productRepo.listPubliclyVisible(shop.id);
  if (filters.categoryId) rows = rows.filter((p) => p.categoryId === filters.categoryId);

  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, { search: filters.search, fields: (p) => [p.name] });
  const { catById, unitById } = await refLookups(shop.id);
  return {
    shop: { id: shop.id, name: shop.name, slug: shop.slug },
    data: data.map((p) => toPublicProduct(p, catById.get(p.categoryId), unitById.get(p.unitId))),
    meta: buildPageMeta(page, limit, total),
  };
}

export async function getProduct(slug: string, productSlug: string) {
  const shop = await resolveActiveShop(slug);
  const product = await productRepo.findBySlug(shop.id, productSlug);
  if (!product || product.status !== productRepo.ProductStatus.ACTIVE) {
    throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  }
  const { catById, unitById } = await refLookups(shop.id);
  return {
    shop: { id: shop.id, name: shop.name, slug: shop.slug, phone: shop.phone, whatsapp: shop.whatsapp },
    product: toPublicProduct(product, catById.get(product.categoryId), unitById.get(product.unitId)),
  };
}
