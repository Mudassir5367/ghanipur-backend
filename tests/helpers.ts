import request from 'supertest';
import type { Express } from 'express';
import * as userRepo from '../src/repositories/dynamo/userRepository.js';
import { Role } from '../src/constants/roles.js';
import { hashPassword } from '../src/services/token.service.js';
import { provisionShop } from '../src/modules/shop/shop.service.js';
import { ShopStatus } from '../src/models/shop.model.js';

export interface TestActor {
  token: string;
  userId: string;
  shopId: string | null;
  email: string;
}

/**
 * Provision a SHOP_ADMIN with a shop and return an authenticated actor.
 * Uses the service layer directly (bare shop, no default categories) so existing
 * catalog/isolation tests keep a clean 0-category baseline. New-onboarding
 * behaviour (default categories, /shops/mine, /admin/register) is covered by
 * onboarding.test.ts against the real HTTP endpoints.
 */
export async function registerShop(
  app: Express,
  overrides: Partial<{ email: string; password: string; shopName: string; status: ShopStatus }> = {},
): Promise<TestActor> {
  const email = overrides.email ?? `owner_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`;
  const password = overrides.password ?? 'password123';
  const user = await userRepo.create({ name: 'Owner', email, passwordHash: await hashPassword(password), role: Role.SHOP_ADMIN });
  const shop = await provisionShop(undefined, { _id: user.id }, overrides.shopName ?? 'Test Dairy', { status: overrides.status ?? ShopStatus.PENDING, seedCategories: false });
  await userRepo.update(user.id, { shopId: shop._id.toString() });

  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`registerShop login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken, userId: user.id, shopId: shop._id.toString(), email };
}

/** Create a SUPER_ADMIN directly and log in to obtain a token. */
export async function createSuperAdmin(app: Express): Promise<TestActor> {
  const email = `super_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@test.com`;
  const password = 'password123';
  await userRepo.create({ name: 'Super', email, passwordHash: await hashPassword(password), role: Role.SUPER_ADMIN });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { token: res.body.data.accessToken, userId: res.body.data.user.id, shopId: null, email };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
