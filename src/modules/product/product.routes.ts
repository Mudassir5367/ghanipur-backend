import { Router } from 'express';
import * as controller from './product.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { Permission } from '../../constants/permissions.js';
import { idParamSchema } from '../../utils/validators.js';
import { createProductSchema, updateProductSchema, inventoryMovementSchema } from './product.validators.js';

export const productRouter = Router();

productRouter.use(authenticate, resolveTenant);

productRouter.get('/', authorize(Permission.PRODUCT_VIEW), controller.list);
// Specific path before /:id so "sku" is not treated as an id.
productRouter.get('/sku/suggest', authorize(Permission.PRODUCT_CREATE), controller.suggestSku);
productRouter.get('/:id', authorize(Permission.PRODUCT_VIEW), validate({ params: idParamSchema }), controller.get);
productRouter.post('/', authorize(Permission.PRODUCT_CREATE), validate({ body: createProductSchema }), controller.create);
productRouter.patch('/:id', authorize(Permission.PRODUCT_UPDATE), validate({ params: idParamSchema, body: updateProductSchema }), controller.update);
productRouter.delete('/:id', authorize(Permission.PRODUCT_DELETE), validate({ params: idParamSchema }), controller.remove);

// Inventory ledger for a product (§9)
productRouter.get('/:id/inventory', authorize(Permission.INVENTORY_VIEW), validate({ params: idParamSchema }), controller.ledger);
productRouter.post('/:id/inventory', authorize(Permission.INVENTORY_ADJUST), validate({ params: idParamSchema, body: inventoryMovementSchema }), controller.recordInventory);
