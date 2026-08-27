import { Router } from 'express';
import * as controller from './sale.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { idParamSchema } from '../../utils/validators.js';
import { createSaleSchema } from './sale.validators.js';

export const saleRouter = Router();

saleRouter.use(authenticate, resolveTenant);

saleRouter.get('/', authorize(Permission.SALE_VIEW), controller.list);
saleRouter.get('/:id', authorize(Permission.SALE_VIEW), validate({ params: idParamSchema }), controller.get);
saleRouter.post('/', authorize(Permission.SALE_CREATE), validate({ body: createSaleSchema }), controller.create);
saleRouter.post('/:id/reverse', authorize(Permission.SALE_REVERSE), validate({ params: idParamSchema }), controller.reverse);
