import { Router } from 'express';
import * as controller from './conversion.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { createConversionSchema } from './conversion.validators.js';

export const conversionRouter = Router();

conversionRouter.use(authenticate, resolveTenant);

conversionRouter.get('/', authorize(Permission.INVENTORY_VIEW), controller.list);
conversionRouter.post('/', authorize(Permission.INVENTORY_ADJUST), validate({ body: createConversionSchema }), controller.create);
