import { z } from 'zod';
import { Permission } from '../../constants/permissions.js';

const permissionEnum = z.enum(Object.values(Permission) as [string, ...string[]]);

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  phone: z.string().trim().max(20).optional(),
  // Optional per-user permission overrides (subset of SHOP_STAFF defaults + extras).
  permissions: z.array(permissionEnum).optional(),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().max(20),
    isActive: z.boolean(),
    permissions: z.array(permissionEnum),
  })
  .partial();
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
