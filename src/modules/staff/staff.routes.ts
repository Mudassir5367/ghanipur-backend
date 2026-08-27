import { Router } from 'express';
import * as controller from './staff.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { idParamSchema } from '../../utils/validators.js';
import { createStaffSchema, updateStaffSchema } from './staff.validators.js';

// All staff routes are shop-scoped and require USER_MANAGE.
export const staffRouter = Router();

staffRouter.use(authenticate, authorize(Permission.USER_MANAGE), resolveTenant);

staffRouter.get('/', controller.listStaff);
staffRouter.post('/', validate({ body: createStaffSchema }), controller.createStaff);
staffRouter.patch('/:id', validate({ params: idParamSchema, body: updateStaffSchema }), controller.updateStaff);
staffRouter.delete('/:id', validate({ params: idParamSchema }), controller.deactivateStaff);
