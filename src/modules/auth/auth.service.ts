import { User, type UserDoc } from '../../models/user.model.js';
import { Shop, ShopStatus } from '../../models/shop.model.js';
import { Role } from '../../constants/roles.js';
import { defaultPermissionsFor, type Permission } from '../../constants/permissions.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashPassword,
  verifyPassword,
  hashToken,
  verifyTokenHash,
} from '../../services/token.service.js';
import { ApiError } from '../../utils/ApiError.js';
import type { RegisterInput, LoginInput, AdminRegisterInput, SuperAdminRegisterInput } from './auth.validators.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  avatarUrl?: string | null;
  role: Role;
  shopId: string | null;
  permissions: Permission[];
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

/** Effective permissions = role defaults merged with per-user overrides. */
function effectivePermissions(user: Pick<UserDoc, 'role' | 'permissions'>): Permission[] {
  const set = new Set<string>([...defaultPermissionsFor(user.role as Role), ...(user.permissions ?? [])]);
  return [...set] as Permission[];
}

export function toPublic(user: UserDoc): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role as Role,
    shopId: user.shopId ? user.shopId.toString() : null,
    permissions: effectivePermissions(user),
  };
}

async function issueTokens(user: UserDoc): Promise<AuthResult> {
  const accessToken = signAccessToken({
    sub: user._id.toString(),
    role: user.role as Role,
    shopId: user.shopId ? user.shopId.toString() : null,
    perms: effectivePermissions(user),
  });
  const refreshToken = signRefreshToken(user._id.toString());
  await User.updateOne({ _id: user._id }, { refreshTokenHash: await hashToken(refreshToken) });
  return { user: toPublic(user), accessToken, refreshToken };
}

async function assertEmailFree(email: string): Promise<void> {
  const existing = await User.findOne({ email }).lean();
  if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_TAKEN');
}

/** A suspended/inactive/deleted shop completely locks out its admin and staff. */
async function assertShopUsable(user: Pick<UserDoc, 'role' | 'shopId'>): Promise<void> {
  if (user.role !== Role.SHOP_ADMIN && user.role !== Role.SHOP_STAFF) return;
  if (!user.shopId) return; // no shop yet (admin still onboarding)
  const shop = await Shop.findById(user.shopId, 'status isDeleted').lean();
  if (!shop || shop.isDeleted || shop.status === ShopStatus.SUSPENDED || shop.status === ShopStatus.INACTIVE) {
    throw ApiError.forbidden('This shop has been suspended. Please contact the platform administrator.', 'SHOP_SUSPENDED');
  }
}

/** Public signup: a normal USER (customer). No shop, no admin powers (§1). */
export async function register(input: RegisterInput): Promise<AuthResult> {
  await assertEmailFree(input.email);
  const passwordHash = await hashPassword(input.password);
  const user = await User.create({ name: input.name, email: input.email, phone: input.phone, passwordHash, role: Role.USER });
  return issueTokens(user);
}

/** Provision a SHOP_ADMIN (called by a super admin). Creates only the admin account
 *  — no shop. The admin sets up their own shop after logging in (§2). */
export async function createAdmin(input: AdminRegisterInput): Promise<PublicUser> {
  await assertEmailFree(input.email);
  const passwordHash = await hashPassword(input.password);
  const user = await User.create({ name: input.name, email: input.email, phone: input.phone, passwordHash, role: Role.SHOP_ADMIN });
  return toPublic(user);
}

/** Provision a SUPER_ADMIN (setup key or existing super admin). */
export async function createSuperAdmin(input: SuperAdminRegisterInput): Promise<PublicUser> {
  await assertEmailFree(input.email);
  const passwordHash = await hashPassword(input.password);
  const user = await User.create({ name: input.name, email: input.email, passwordHash, role: Role.SUPER_ADMIN });
  return toPublic(user);
}

/** Re-issue tokens for a user by id (e.g. after their shopId changes). */
export async function issueTokensForUser(userId: string): Promise<AuthResult> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  return issueTokens(user);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');
  if (!user) throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  if (!user.isActive) throw ApiError.forbidden('Account disabled', 'ACCOUNT_DISABLED');

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  await assertShopUsable(user); // suspended shops cannot log in

  user.lastLoginAt = new Date();
  await user.save();
  return issueTokens(user);
}

export async function refresh(refreshToken: string | undefined): Promise<AuthResult> {
  if (!refreshToken) throw ApiError.unauthorized('No refresh token', 'NO_REFRESH_TOKEN');
  let sub: string;
  try {
    ({ sub } = verifyRefreshToken(refreshToken));
  } catch {
    throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }
  const user = await User.findById(sub).select('+refreshTokenHash');
  if (!user || !user.refreshTokenHash) throw ApiError.unauthorized('Session expired', 'SESSION_EXPIRED');
  if (!user.isActive) throw ApiError.forbidden('Account disabled', 'ACCOUNT_DISABLED');

  const matches = await verifyTokenHash(user.refreshTokenHash, refreshToken);
  if (!matches) throw ApiError.unauthorized('Session revoked', 'SESSION_REVOKED');
  await assertShopUsable(user); // a shop suspended mid-session loses access on next refresh

  return issueTokens(user); // rotates the refresh token
}

export async function logout(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { refreshTokenHash: null });
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  return toPublic(user);
}
