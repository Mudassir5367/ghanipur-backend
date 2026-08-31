import * as userRepo from '../../repositories/dynamo/userRepository.js';
import type { UserRecord } from '../../repositories/dynamo/userRepository.js';
import { UniqueConstraintError } from '../../repositories/dynamo/base.js';
import { Role } from '../../constants/roles.js';
import { ApiError } from '../../utils/ApiError.js';
import { hashPassword } from '../../services/token.service.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import type { CreateStaffInput, UpdateStaffInput } from './staff.validators.js';

interface PublicStaff {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  role: Role;
  isActive: boolean;
  permissions: string[];
  lastLoginAt?: Date | null;
}

function toPublic(u: UserRecord): PublicStaff {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    permissions: u.permissions ?? [],
    lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt) : null,
  };
}

/**
 * List the users belonging to a shop (owner + staff), always shop-scoped (§22)
 * via the byShop index.
 *
 * DynamoDB paginates by cursor and has no cheap COUNT, so the page/total
 * response the API promises cannot come from the query itself. Rather than
 * change a contract the frontend already consumes, this reads the shop's users
 * — a small, bounded, single-tenant set — and applies search, sort and paging in
 * memory. That trade is only sound because of the bounded cardinality; the
 * high-volume listings must move to real cursors when they are ported.
 */
export async function listStaff(shopId: string, query: unknown) {
  const { page, limit, skip, search } = parsePagination(query, 'name');

  let users = await userRepo.listAllByShop(shopId);
  if (search) {
    const needle = search.toLowerCase();
    users = users.filter(
      (u) => u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle),
    );
  }
  users.sort((a, b) => a.name.localeCompare(b.name));

  const total = users.length;
  const pageItems = users.slice(skip, skip + limit);
  return { data: pageItems.map(toPublic), meta: buildPageMeta(page, limit, total) };
}

export async function createStaff(shopId: string, input: CreateStaffInput): Promise<PublicStaff> {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await userRepo.create({
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash,
      role: Role.SHOP_STAFF,
      shopId,
      permissions: input.permissions ?? [],
    });
    return toPublic(user);
  } catch (err) {
    // The email guard rejects duplicates atomically, closing the race the old
    // findOne-then-create left open.
    if (err instanceof UniqueConstraintError) {
      throw ApiError.conflict('Email already registered', 'EMAIL_TAKEN');
    }
    throw err;
  }
}

/** Fetch a staff user, guaranteeing it belongs to this shop. */
async function findScoped(shopId: string, id: string): Promise<UserRecord> {
  const user = await userRepo.findScopedToShop(shopId, id);
  if (!user) throw ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND');
  return user;
}

export async function updateStaff(shopId: string, id: string, input: UpdateStaffInput): Promise<PublicStaff> {
  const user = await findScoped(shopId, id);
  // The shop owner (SHOP_ADMIN) cannot be demoted/deactivated via staff management.
  if (user.role === Role.SHOP_ADMIN && input.isActive === false) {
    throw ApiError.badRequest('Cannot deactivate the shop owner', 'OWNER_PROTECTED');
  }
  const patch: userRepo.UserPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.permissions !== undefined) patch.permissions = input.permissions;
  await userRepo.update(id, patch);
  return toPublic({ ...user, ...patch });
}

export async function deactivateStaff(shopId: string, id: string): Promise<PublicStaff> {
  const user = await findScoped(shopId, id);
  if (user.role === Role.SHOP_ADMIN) throw ApiError.badRequest('Cannot deactivate the shop owner', 'OWNER_PROTECTED');
  const patch: userRepo.UserPatch = { isActive: false, refreshTokenHash: null }; // revoke sessions
  await userRepo.update(id, patch);
  return toPublic({ ...user, ...patch });
}
