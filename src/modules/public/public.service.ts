import { Shop, ShopStatus } from '../../models/shop.model.js';
import { Category, CategoryStatus } from '../../models/category.model.js';
import { Product, ProductStatus } from '../../models/product.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';

// Public-safe product projection — never expose purchase cost or internal fields (§32).
const PUBLIC_PRODUCT_FIELDS = 'name slug description images sellingPriceMinor unitValue currentStock trackInventory isAvailable categoryId unitId';

async function resolveActiveShop(slug: string) {
  const shop = await Shop.findOne({ slug, status: ShopStatus.ACTIVE, isDeleted: false });
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

export async function listShops(query: unknown) {
  const { page, limit, skip, search } = parsePagination(query, 'name');
  const filter: Record<string, unknown> = { status: ShopStatus.ACTIVE, isDeleted: false };
  if (search) filter.name = { $regex: search, $options: 'i' };
  const [data, total] = await Promise.all([
    Shop.find(filter, 'name slug logo banner description address phone whatsapp').sort({ name: 1 }).skip(skip).limit(limit),
    Shop.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getShop(slug: string) {
  const shop = await resolveActiveShop(slug);
  const categories = await Category.find({ shopId: shop._id, status: CategoryStatus.ACTIVE, isDeleted: false }, 'name slug image icon sortOrder').sort({ sortOrder: 1, name: 1 });
  return { shop, categories };
}

export async function listProducts(slug: string, query: unknown, filters: { categoryId?: string; search?: string }) {
  const shop = await resolveActiveShop(slug);
  const { page, limit, skip } = parsePagination(query, '-createdAt');
  const filter: Record<string, unknown> = { shopId: shop._id, status: ProductStatus.ACTIVE, isAvailable: true, isDeleted: false };
  if (filters.categoryId) filter.categoryId = filters.categoryId;
  if (filters.search) filter.name = { $regex: filters.search, $options: 'i' };
  const [data, total] = await Promise.all([
    Product.find(filter, PUBLIC_PRODUCT_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('categoryId', 'name slug').populate('unitId', 'name symbol'),
    Product.countDocuments(filter),
  ]);
  return { shop: { id: shop._id, name: shop.name, slug: shop.slug }, data, meta: buildPageMeta(page, limit, total) };
}

export async function getProduct(slug: string, productSlug: string) {
  const shop = await resolveActiveShop(slug);
  const product = await Product.findOne(
    { shopId: shop._id, slug: productSlug, status: ProductStatus.ACTIVE, isDeleted: false },
    PUBLIC_PRODUCT_FIELDS,
  ).populate('categoryId', 'name slug').populate('unitId', 'name symbol');
  if (!product) throw ApiError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  return { shop: { id: shop._id, name: shop.name, slug: shop.slug, phone: shop.phone, whatsapp: shop.whatsapp }, product };
}
