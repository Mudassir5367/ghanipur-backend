import { Router } from 'express';
import * as controller from './category.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { idParamSchema } from '../../utils/validators.js';
import { createCategorySchema, updateCategorySchema } from './category.validators.js';

export const categoryRouter = Router();

categoryRouter.use(authenticate, resolveTenant);

categoryRouter.get('/', authorize(Permission.CATEGORY_VIEW), controller.list);
categoryRouter.get('/:id', authorize(Permission.CATEGORY_VIEW), validate({ params: idParamSchema }), controller.get);
categoryRouter.post('/', authorize(Permission.CATEGORY_CREATE), validate({ body: createCategorySchema }), controller.create);
categoryRouter.patch('/:id', authorize(Permission.CATEGORY_UPDATE), validate({ params: idParamSchema, body: updateCategorySchema }), controller.update);
categoryRouter.delete('/:id', authorize(Permission.CATEGORY_DELETE), validate({ params: idParamSchema }), controller.remove);
