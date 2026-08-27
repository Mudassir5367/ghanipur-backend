import { Router } from 'express';
import { z } from 'zod';
import * as controller from './delivery.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { idParamSchema, objectId } from '../../utils/validators.js';
import { createDeliverySchema, updateStatusSchema, addPaymentSchema } from './delivery.validators.js';

export const deliveryRouter = Router();

deliveryRouter.use(authenticate, resolveTenant);

deliveryRouter.get('/', authorize(Permission.DELIVERY_VIEW), controller.list);
deliveryRouter.get('/customer/:customerId', authorize(Permission.DELIVERY_VIEW), validate({ params: z.object({ customerId: objectId }) }), controller.customerSummary);
deliveryRouter.get('/:id', authorize(Permission.DELIVERY_VIEW), validate({ params: idParamSchema }), controller.get);
deliveryRouter.post('/', authorize(Permission.DELIVERY_MANAGE), validate({ body: createDeliverySchema }), controller.create);
deliveryRouter.patch('/:id/status', authorize(Permission.DELIVERY_MANAGE), validate({ params: idParamSchema, body: updateStatusSchema }), controller.setStatus);
deliveryRouter.post('/:id/payments', authorize(Permission.DELIVERY_MANAGE), validate({ params: idParamSchema, body: addPaymentSchema }), controller.addPayment);
