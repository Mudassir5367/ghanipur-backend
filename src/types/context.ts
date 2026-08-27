import type { Role } from '../constants/roles.js';
import type { Permission } from '../constants/permissions.js';

/** Authenticated principal attached to the request by `authenticate`. */
export interface AuthContext {
  userId: string;
  role: Role;
  shopId: string | null;
  permissions: Permission[];
}

/** Resolved tenant the request operates within (set by `resolveTenant`). */
export interface TenantContext {
  shopId: string;
  /** True when a SUPER_ADMIN is acting on a shop that isn't their own. */
  impersonated: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      tenant?: TenantContext;
      id?: string;
    }
  }
}

export {};
