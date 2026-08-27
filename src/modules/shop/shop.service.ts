import type { ClientSession } from 'mongoose';
import { Shop, ShopStatus, type ShopDoc } from '../../models/shop.model.js';
import { ShopSettings } from '../../models/shopSettings.model.js';
import { Category } from '../../models/category.model.js';
import { User } from '../../models/user.model.js';
import { Role } from '../../constants/roles.js';
import { ApiError } from '../../utils/ApiError.js';
import { uniqueSlug, slugify } from '../../utils/slug.js';
import { hashPassword } from '../../services/token.service.js';
import { withTransaction } from '../../utils/withTransaction.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { DEFAULT_CATEGORIES } from '../../constants/categories.js';
import type { UpdateShopInput, CreateShopInput, UpdateSettingsInput } from './shop.validators.js';

const activeFilter = { isDeleted: false } as const;

/**
 * Create a shop with its default settings and starter categories (§3), and attach
 * it to the owner. Shared by super-admin shop creation, admin self-onboarding, and
 * the seed script so there is one provisioning path.
 */
export async function provisionShop(
  session: ClientSession | undefined,
  owner: { _id: unknown },
  shopName: string,
  opts: { phone?: string; status?: ShopStatus; seedCategories?: boolean } = {},
): Promise<ShopDoc> {
  const slug = await uniqueSlug(shopName, async (s) => !!(await Shop.exists({ slug: s })));
  const [shop] = await Shop.create(
    [{ name: shopName, slug, ownerId: owner._id, phone: opts.phone, status: opts.status ?? ShopStatus.PENDING }],
    { session },
  );
  await ShopSettings.create([{ shopId: shop!._id }], { session });
  if (opts.seedCategories !== false) {
    await Category.create(
      DEFAULT_CATEGORIES.map((name, i) => ({ shopId: shop!._id, name, slug: slugify(name), sortOrder: i })),
      { session, ordered: true },
    );
  }
  return shop!;
}

function shopById(id: string) {
  return Shop.findOne({ _id: id, isDeleted: false });
}

/** Shop admin: fetch own shop (shopId from tenant context). */
export async function getShop(shopId: string): Promise<ShopDoc> {
  const shop = await shopById(shopId);
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

export async function updateShop(shopId: string, input: UpdateShopInput): Promise<ShopDoc> {
  const shop = await Shop.findOneAndUpdate({ _id: shopId, isDeleted: false }, input, { new: true });
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

// ---- Settings ----
export async function getSettings(shopId: string) {
  let settings = await ShopSettings.findOne({ shopId });
  if (!settings) settings = await ShopSettings.create({ shopId }); // self-heal legacy shops
  return settings;
}

export async function updateSettings(shopId: string, input: UpdateSettingsInput) {
  const settings = await ShopSettings.findOneAndUpdate({ shopId }, input, { new: true, upsert: true });
  return settings;
}

// ---- Public storefront ----
export async function getPublicShopBySlug(slug: string): Promise<ShopDoc> {
  const shop = await Shop.findOne({ slug, status: ShopStatus.ACTIVE, isDeleted: false });
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

export async function listPublicShops(query: unknown) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'name');
  const filter: Record<string, unknown> = { status: ShopStatus.ACTIVE, isDeleted: false };
  if (search) filter.name = { $regex: search, $options: 'i' };
  const [data, total] = await Promise.all([
    Shop.find(filter, 'name slug logo banner description address city phone whatsapp').sort(sort).skip(skip).limit(limit),
    Shop.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}

// ---- Super admin ----
export async function listShops(query: unknown, status?: ShopStatus) {
  const { page, limit, skip, sort, search } = parsePagination(query, '-createdAt');
  const filter: Record<string, unknown> = { ...activeFilter };
  if (status) filter.status = status;
  if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { slug: { $regex: search, $options: 'i' } }];
  const [data, total] = await Promise.all([
    Shop.find(filter).sort(sort).skip(skip).limit(limit),
    Shop.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getShopByIdAdmin(id: string): Promise<ShopDoc> {
  const shop = await shopById(id);
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

export async function createShop(input: CreateShopInput): Promise<ShopDoc> {
  const existing = await User.findOne({ email: input.ownerEmail }).lean();
  if (existing) throw ApiError.conflict('Owner email already registered', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.ownerPassword);

  return withTransaction(async (session) => {
    const [owner] = await User.create(
      [{ name: input.ownerName, email: input.ownerEmail, phone: input.phone, passwordHash, role: Role.SHOP_ADMIN }],
      { session },
    );
    // Super-admin-created shops are pre-approved by default.
    const shop = await provisionShop(session, owner!, input.shopName, { phone: input.phone, status: input.status ?? ShopStatus.ACTIVE });
    owner!.shopId = shop._id;
    await owner!.save({ session });
    return shop;
  });
}

/**
 * A logged-in SHOP_ADMIN who does not yet have a shop creates their own (§2).
 * Returns the shop; the caller must re-issue the admin's token because the
 * embedded shopId changes.
 */
export async function createMyShop(userId: string, input: { shopName: string; phone?: string }): Promise<ShopDoc> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (user.role !== Role.SHOP_ADMIN) throw ApiError.forbidden('Only shop admins can create a shop', 'FORBIDDEN');
  if (user.shopId) throw ApiError.conflict('You already have a shop', 'SHOP_EXISTS');

  return withTransaction(async (session) => {
    // Go live immediately so the owner's storefront is reachable and appears on
    // the public /shops directory without waiting for a separate approval step.
    const shop = await provisionShop(session, user, input.shopName, { phone: input.phone, status: ShopStatus.ACTIVE });
    user.shopId = shop._id;
    await user.save({ session });
    return shop;
  });
}

export async function setShopStatus(id: string, status: ShopStatus): Promise<ShopDoc> {
  const shop = await Shop.findOneAndUpdate({ _id: id, isDeleted: false }, { status }, { new: true });
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}
