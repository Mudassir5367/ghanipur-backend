import { Router } from 'express';
import * as controller from './payment.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { idParamSchema } from '../../utils/validators.js';
import { createPaymentSchema } from './payment.validators.js';

export const paymentRouter = Router();

paymentRouter.use(authenticate, resolveTenant);

paymentRouter.get('/', authorize(Permission.PAYMENT_VIEW), controller.list);
paymentRouter.post('/', authorize(Permission.PAYMENT_CREATE), validate({ body: createPaymentSchema }), controller.create);
paymentRouter.post('/:id/reverse', authorize(Permission.PAYMENT_REVERSE), validate({ params: idParamSchema }), controller.reverse);
