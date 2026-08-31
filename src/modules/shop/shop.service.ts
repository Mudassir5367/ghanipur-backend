import { Category } from '../../models/category.model.js';
import * as shopRepo from '../../repositories/dynamo/shopRepository.js';
import * as settingsRepo from '../../repositories/dynamo/shopSettingsRepository.js';
import * as userRepo from '../../repositories/dynamo/userRepository.js';
import { UniqueConstraintError } from '../../repositories/dynamo/base.js';
import { ShopStatus, type ShopRecord } from '../../repositories/dynamo/shopRepository.js';
import { Role } from '../../constants/roles.js';
import { ApiError } from '../../utils/ApiError.js';
import { uniqueSlug, slugify } from '../../utils/slug.js';
import { hashPassword } from '../../services/token.service.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { DEFAULT_CATEGORIES } from '../../constants/categories.js';
import { logger } from '../../config/logger.js';
import type { UpdateShopInput, CreateShopInput, UpdateSettingsInput } from './shop.validators.js';

export { ShopStatus };
export type ShopDoc = ShopRecord;

/**
 * Create a shop with its default settings and starter categories (§3), and
 * attach it to the owner. Shared by super-admin shop creation, admin
 * self-onboarding, and the seed script so there is one provisioning path.
 *
 * The shop, its uniqueness guards and its settings row go in ONE DynamoDB
 * transaction, so a shop can never exist without settings or with a duplicate
 * slug. Starter categories are still in Mongo and therefore outside that
 * transaction; they are seeded best-effort, because a shop with no starter
 * categories is a cosmetic gap the owner can fix, not a corrupt shop. That
 * caveat disappears when Category moves.
 */
export async function provisionShop(
  _session: unknown,
  owner: { _id: unknown },
  shopName: string,
  opts: { phone?: string; status?: ShopStatus; seedCategories?: boolean } = {},
): Promise<ShopDoc> {
  const ownerId = String(owner._id);
  const slug = await uniqueSlug(shopName, async (s) => shopRepo.slugExists(s));

  const shop = await shopRepo
    .create(
      { name: shopName, slug, ownerId, phone: opts.phone, status: opts.status ?? ShopStatus.PENDING },
      // Written in the same transaction as the shop, so a shop can never exist
      // without settings.
      (shopId) => [{ table: settingsRepo.SETTINGS_TABLE, item: settingsRepo.buildDefaults(shopId) }],
    )
    .catch((err: unknown) => {
      if (err instanceof UniqueConstraintError && err.field === 'ownerId') {
        throw ApiError.conflict('You already have a shop', 'SHOP_EXISTS');
      }
      throw err;
    });

  if (opts.seedCategories !== false) {
    try {
      await Category.create(
        DEFAULT_CATEGORIES.map((name, i) => ({ shopId: shop.id, name, slug: slugify(name), sortOrder: i })),
        { ordered: true },
      );
    } catch (err) {
      logger.warn({ err, shopId: shop.id }, 'Starter categories not seeded; shop is usable without them');
    }
  }
  return shop;
}

/** Shop admin: fetch own shop (shopId from tenant context). */
export async function getShop(shopId: string): Promise<ShopDoc> {
  const shop = await shopRepo.findById(shopId);
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

export async function updateShop(shopId: string, input: UpdateShopInput): Promise<ShopDoc> {
  const shop = await shopRepo.update(shopId, input as shopRepo.ShopPatch);
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

// ---- Settings ----
export async function getSettings(shopId: string) {
  return settingsRepo.getOrCreate(shopId);
}

export async function updateSettings(shopId: string, input: UpdateSettingsInput) {
  return settingsRepo.update(shopId, input as settingsRepo.SettingsPatch);
}

// ---- Public storefront ----
export async function getPublicShopBySlug(slug: string): Promise<ShopDoc> {
  const shop = await shopRepo.findBySlug(slug);
  if (!shop || shop.status !== ShopStatus.ACTIVE) {
    throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  }
  return shop;
}

export async function listPublicShops(query: unknown) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'name');
  const rows = await shopRepo.listByStatus(ShopStatus.ACTIVE);
  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, { search, fields: (s) => [s.name] });
  return { data, meta: buildPageMeta(page, limit, total) };
}

// ---- Super admin ----
export async function listShops(query: unknown, status?: ShopStatus) {
  const { page, limit, skip, sort, search } = parsePagination(query, '-createdAt');
  const rows = status ? await shopRepo.listByStatus(status) : await shopRepo.listAllActive();
  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, { search, fields: (s) => [s.name, s.slug] });
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getShopByIdAdmin(id: string): Promise<ShopDoc> {
  const shop = await shopRepo.findById(id);
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}

/**
 * Creates the owner account and their shop.
 *
 * Both now live in DynamoDB but in different tables with different partition
 * keys, and the owner must exist before the shop can reference it, so this is
 * still two writes. A failure after the owner exists is compensated by deleting
 * it and releasing its email guard, so a half-created owner never blocks the
 * address.
 */
export async function createShop(input: CreateShopInput): Promise<ShopDoc> {
  const passwordHash = await hashPassword(input.ownerPassword);

  let owner;
  try {
    owner = await userRepo.create({
      name: input.ownerName,
      email: input.ownerEmail,
      phone: input.phone,
      passwordHash,
      role: Role.SHOP_ADMIN,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw ApiError.conflict('Owner email already registered', 'EMAIL_TAKEN');
    }
    throw err;
  }

  try {
    // Super-admin-created shops are pre-approved by default.
    const shop = await provisionShop(undefined, { _id: owner.id }, input.shopName, {
      phone: input.phone,
      status: input.status ?? ShopStatus.ACTIVE,
    });
    await userRepo.update(owner.id, { shopId: shop.id });
    return shop;
  } catch (err) {
    await userRepo.hardDelete(owner.id, owner.email).catch(() => {
      /* compensation is best-effort; the original failure is what matters */
    });
    throw err;
  }
}

/**
 * A logged-in SHOP_ADMIN who does not yet have a shop creates their own (§2).
 * Returns the shop; the caller must re-issue the admin's token because the
 * embedded shopId changes.
 */
export async function createMyShop(userId: string, input: { shopName: string; phone?: string }): Promise<ShopDoc> {
  const user = await userRepo.findById(userId);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (user.role !== Role.SHOP_ADMIN) throw ApiError.forbidden('Only shop admins can create a shop', 'FORBIDDEN');
  if (user.shopId) throw ApiError.conflict('You already have a shop', 'SHOP_EXISTS');

  // Go live immediately so the owner's storefront is reachable and appears on
  // the public /shops directory without waiting for a separate approval step.
  const shop = await provisionShop(undefined, { _id: user.id }, input.shopName, {
    phone: input.phone,
    status: ShopStatus.ACTIVE,
  });

  try {
    await userRepo.update(user.id, { shopId: shop.id });
  } catch (err) {
    // The owner is fine; it is the shop that would be orphaned — unreachable by
    // its owner and still holding the slug. Roll it back instead.
    await shopRepo.hardDelete(shop).catch(() => undefined);
    throw err;
  }
  return shop;
}

export async function setShopStatus(id: string, status: ShopStatus): Promise<ShopDoc> {
  const shop = await shopRepo.setStatus(id, status);
  if (!shop) throw ApiError.notFound('Shop not found', 'SHOP_NOT_FOUND');
  return shop;
}
