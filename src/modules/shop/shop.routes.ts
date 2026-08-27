import { Router } from 'express';
import * as controller from './shop.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize, requireRole } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { Role } from '../../constants/roles.js';
import { idParamSchema, slugParamSchema } from '../../utils/validators.js';
import {
  updateShopSchema,
  createShopSchema,
  createMyShopSchema,
  updateStatusSchema,
  updateSettingsSchema,
} from './shop.validators.js';

export const shopRouter = Router();

// ---- Public storefront (no auth) — specific paths before /:id ----
shopRouter.get('/public', controller.listPublicShops);
shopRouter.get('/public/:slug', validate({ params: slugParamSchema }), controller.getPublicShop);

// ---- Shop admin self-onboarding (§2): create own shop (no tenant yet) ----
shopRouter.post('/mine', authenticate, requireRole(Role.SHOP_ADMIN), validate({ body: createMyShopSchema }), controller.createMyShop);

// ---- Own shop (shop context) ----
shopRouter.get('/me', authenticate, authorize(Permission.SHOP_VIEW), resolveTenant, controller.getMyShop);
shopRouter.patch('/me', authenticate, authorize(Permission.SHOP_UPDATE), resolveTenant, validate({ body: updateShopSchema }), controller.updateMyShop);
shopRouter.get('/me/settings', authenticate, authorize(Permission.SETTINGS_VIEW), resolveTenant, controller.getMySettings);
shopRouter.patch('/me/settings', authenticate, authorize(Permission.SETTINGS_UPDATE), resolveTenant, validate({ body: updateSettingsSchema }), controller.updateMySettings);

// ---- Super admin (platform) ----
shopRouter.get('/', authenticate, requireRole(Role.SUPER_ADMIN), controller.listShops);
shopRouter.post('/', authenticate, requireRole(Role.SUPER_ADMIN), validate({ body: createShopSchema }), controller.createShop);
shopRouter.get('/:id', authenticate, requireRole(Role.SUPER_ADMIN), validate({ params: idParamSchema }), controller.getShop);
shopRouter.patch('/:id/status', authenticate, requireRole(Role.SUPER_ADMIN), validate({ params: idParamSchema, body: updateStatusSchema }), controller.updateShopStatus);
