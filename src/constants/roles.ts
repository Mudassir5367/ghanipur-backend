export const Role = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  SHOP_ADMIN: 'SHOP_ADMIN',
  SHOP_STAFF: 'SHOP_STAFF',
  USER: 'USER',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ROLES = Object.values(Role);

/** Roles that belong to a shop (must carry a shopId). */
export const SHOP_SCOPED_ROLES: Role[] = [Role.SHOP_ADMIN, Role.SHOP_STAFF];
