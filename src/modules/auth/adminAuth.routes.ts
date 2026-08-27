import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import * as controller from './auth.controller.js';
import { validate } from '../../middlewares/validate.js';
import { optionalAuth } from '../../middlewares/authenticate.js';
import { Role } from '../../constants/roles.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { adminRegisterSchema, superAdminRegisterSchema } from './auth.validators.js';

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

/**
 * Provisioning gate: allow when the caller is an existing SUPER_ADMIN, OR presents
 * the matching static `x-setup-key` header. Never a public signup. Each endpoint
 * checks its own key so an admin key can't create a super admin.
 */
function requireSetupKey(expected: string | undefined, what: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.auth?.role === Role.SUPER_ADMIN) return next();
    const key = req.header('x-setup-key');
    if (expected && key && key === expected) return next();
    throw ApiError.forbidden(`${what} requires a valid x-setup-key header or a super admin`, 'SETUP_FORBIDDEN');
  };
}

// Mounted at /admin — x-setup-key: ADMIN_SETUP_KEY (or a super-admin token).
export const adminAuthRouter = Router();
adminAuthRouter.post('/register', limiter, optionalAuth, requireSetupKey(env.ADMIN_SETUP_KEY, 'Admin provisioning'), validate({ body: adminRegisterSchema }), controller.registerAdmin);

// Mounted at /super-admin — x-setup-key: SUPER_ADMIN_SETUP_KEY (or a super-admin token).
export const superAdminAuthRouter = Router();
superAdminAuthRouter.post('/register', limiter, optionalAuth, requireSetupKey(env.SUPER_ADMIN_SETUP_KEY, 'Super admin provisioning'), validate({ body: superAdminRegisterSchema }), controller.registerSuperAdmin);
