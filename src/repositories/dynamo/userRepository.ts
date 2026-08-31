import { TABLES } from '../../config/dynamoTables.js';
import type { Role } from '../../constants/roles.js';
import {
  deleteItem,
  getItem,
  putWithGuards,
  queryOneByIndex,
  queryPageByIndex,
  releaseGuard,
  updateItem,
  type GuardSpec,
} from './base.js';
import { newId } from './id.js';

/**
 * DynamoDB-backed User store, replacing the Mongoose `User` model.
 *
 * Layout: one item per user at {id, sk:"META"}, with `byEmail` for login and
 * `byShop` for shop-scoped staff listing. Email uniqueness — a Mongo unique
 * index before — is enforced by the UserEmailGuard table, written in the same
 * transaction as the user (see putWithGuards).
 *
 * Dates are stored as ISO strings; DynamoDB has no date type. The `toDate`
 * helpers keep the Date-shaped contract the services already expose.
 */

export interface UserRecord {
  id: string;
  sk: 'META';
  name: string;
  email: string;
  phone?: string | null;
  passwordHash: string;
  avatarUrl: string | null;
  role: Role;
  /** Absent (not null) for SUPER_ADMIN/USER so they stay out of the byShop index. */
  shopId?: string;
  permissions: string[];
  isActive: boolean;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  refreshTokenHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  phone?: string | null;
  passwordHash: string;
  role: Role;
  shopId?: string | null;
  permissions?: string[];
}

const USERS = TABLES.User as string;
const EMAIL_GUARD = TABLES.UserEmailGuard as string;

function emailGuard(email: string): GuardSpec {
  return {
    table: EMAIL_GUARD,
    key: { email: email.toLowerCase(), sk: 'GUARD' },
    pkName: 'email',
    field: 'email',
  };
}

export async function findById(id: string): Promise<UserRecord | null> {
  return getItem<UserRecord>(USERS, { id, sk: 'META' });
}

export async function findByEmail(email: string): Promise<UserRecord | null> {
  return queryOneByIndex<UserRecord>(USERS, 'byEmail', 'email', email.toLowerCase());
}

export async function emailExists(email: string): Promise<boolean> {
  return (await findByEmail(email)) !== null;
}

/** Throws UniqueConstraintError('email') if the address is already claimed. */
export async function create(input: CreateUserInput): Promise<UserRecord> {
  const now = new Date().toISOString();
  const email = input.email.toLowerCase();
  const record: UserRecord = {
    id: newId(),
    sk: 'META',
    name: input.name,
    email,
    phone: input.phone ?? null,
    passwordHash: input.passwordHash,
    avatarUrl: null,
    role: input.role,
    permissions: input.permissions ?? [],
    isActive: true,
    emailVerifiedAt: null,
    lastLoginAt: null,
    refreshTokenHash: null,
    createdAt: now,
    updatedAt: now,
  };
  // Only set when present: an explicit null would still index into byShop.
  if (input.shopId) record.shopId = input.shopId;

  await putWithGuards(USERS, record, [emailGuard(email)]);
  return record;
}

export type UserPatch = Partial<
  Pick<
    UserRecord,
    | 'name'
    | 'phone'
    | 'avatarUrl'
    | 'role'
    | 'shopId'
    | 'permissions'
    | 'isActive'
    | 'passwordHash'
    | 'refreshTokenHash'
    | 'emailVerifiedAt'
    | 'lastLoginAt'
  >
>;

export async function update(id: string, patch: UserPatch): Promise<void> {
  await updateItem(USERS, { id, sk: 'META' }, { ...patch, updatedAt: new Date().toISOString() });
}

export async function setRefreshTokenHash(id: string, hash: string | null): Promise<void> {
  await update(id, { refreshTokenHash: hash });
}

export async function touchLastLogin(id: string): Promise<void> {
  await update(id, { lastLoginAt: new Date().toISOString() });
}

/** Users attached to one shop (owner + staff), newest id first. */
export async function listByShop(
  shopId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<{ items: UserRecord[]; cursor: string | null }> {
  return queryPageByIndex<UserRecord>(USERS, 'byShop', 'shopId', shopId, opts);
}

/**
 * Every user in one shop, following the cursor to the end.
 *
 * Safe only because a shop's staff list is inherently small and bounded — it is
 * one tenant's employees, and the byShop index keeps the read scoped to them.
 * Do NOT copy this for sales, products or ledger entries; those are unbounded
 * and must stay cursor-paginated.
 */
export async function listAllByShop(shopId: string, hardCap = 1_000): Promise<UserRecord[]> {
  const all: UserRecord[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: UserRecord[]; cursor: string | null } = await listByShop(shopId, { limit: 100, cursor });
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor && all.length < hardCap);
  return all;
}

/** Scoped fetch — never trust a caller-supplied id to belong to this shop (§22). */
export async function findScopedToShop(shopId: string, id: string): Promise<UserRecord | null> {
  const user = await findById(id);
  return user && user.shopId === shopId ? user : null;
}

/** Frees the address so it can be reclaimed. Only for a hard delete. */
export async function releaseEmail(email: string): Promise<void> {
  await releaseGuard(emailGuard(email));
}

/**
 * Removes a user and frees its email.
 *
 * Exists to compensate a failed multi-store creation: while User lives in
 * DynamoDB and Shop still lives in Mongo, "create owner then provision shop"
 * cannot be one transaction, so a caller that fails partway must undo the user
 * it created. Not a general-purpose delete — deactivate users instead, so their
 * audit trail and foreign keys survive.
 */
export async function hardDelete(id: string, email: string): Promise<void> {
  await deleteItem(USERS, { id, sk: 'META' });
  await releaseEmail(email);
}
