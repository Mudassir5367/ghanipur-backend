import { Router } from 'express';
import * as controller from './customer.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { idParamSchema } from '../../utils/validators.js';
import { createCustomerSchema, updateCustomerSchema } from './customer.validators.js';

export const customerRouter = Router();

customerRouter.use(authenticate, resolveTenant);

customerRouter.get('/', authorize(Permission.CUSTOMER_VIEW), controller.list);
customerRouter.get('/:id', authorize(Permission.CUSTOMER_VIEW), validate({ params: idParamSchema }), controller.get);
customerRouter.get('/:id/ledger', authorize(Permission.LEDGER_VIEW), validate({ params: idParamSchema }), controller.ledger);
customerRouter.post('/', authorize(Permission.CUSTOMER_CREATE), validate({ body: createCustomerSchema }), controller.create);
customerRouter.patch('/:id', authorize(Permission.CUSTOMER_UPDATE), validate({ params: idParamSchema, body: updateCustomerSchema }), controller.update);
customerRouter.delete('/:id', authorize(Permission.CUSTOMER_DELETE), validate({ params: idParamSchema }), controller.remove);
