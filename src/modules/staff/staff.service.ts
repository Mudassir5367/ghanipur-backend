import { User, type UserHydrated } from '../../models/user.model.js';
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

function toPublic(u: UserHydrated): PublicStaff {
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role as Role,
    isActive: u.isActive,
    permissions: u.permissions ?? [],
    lastLoginAt: u.lastLoginAt,
  };
}

/** List all users belonging to a shop (owner + staff). Always shop-scoped (§22). */
export async function listStaff(shopId: string, query: unknown) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'name');
  const filter: Record<string, unknown> = { shopId };
  if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }];
  const [users, total] = await Promise.all([
    User.find(filter).sort(sort).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return { data: users.map(toPublic), meta: buildPageMeta(page, limit, total) };
}

export async function createStaff(shopId: string, input: CreateStaffInput): Promise<PublicStaff> {
  const existing = await User.findOne({ email: input.email }).lean();
  if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.password);
  const user = await User.create({
    name: input.name,
    email: input.email,
    phone: input.phone,
    passwordHash,
    role: Role.SHOP_STAFF,
    shopId,
    permissions: input.permissions ?? [],
  });
  return toPublic(user);
}

/** Fetch a staff user, guaranteeing it belongs to this shop. */
async function findScoped(shopId: string, id: string): Promise<UserHydrated> {
  const user = await User.findOne({ _id: id, shopId });
  if (!user) throw ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND');
  return user;
}

export async function updateStaff(shopId: string, id: string, input: UpdateStaffInput): Promise<PublicStaff> {
  const user = await findScoped(shopId, id);
  // The shop owner (SHOP_ADMIN) cannot be demoted/deactivated via staff management.
  if (user.role === Role.SHOP_ADMIN && input.isActive === false) {
    throw ApiError.badRequest('Cannot deactivate the shop owner', 'OWNER_PROTECTED');
  }
  if (input.name !== undefined) user.name = input.name;
  if (input.phone !== undefined) user.phone = input.phone;
  if (input.isActive !== undefined) user.isActive = input.isActive;
  if (input.permissions !== undefined) user.permissions = input.permissions;
  await user.save();
  return toPublic(user);
}

export async function deactivateStaff(shopId: string, id: string): Promise<PublicStaff> {
  const user = await findScoped(shopId, id);
  if (user.role === Role.SHOP_ADMIN) throw ApiError.badRequest('Cannot deactivate the shop owner', 'OWNER_PROTECTED');
  user.isActive = false;
  user.refreshTokenHash = null; // revoke sessions
  await user.save();
  return toPublic(user);
}
