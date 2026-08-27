import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { adminAuthRouter, superAdminAuthRouter } from '../modules/auth/adminAuth.routes.js';
import { shopRouter } from '../modules/shop/shop.routes.js';
import { staffRouter } from '../modules/staff/staff.routes.js';
import { categoryRouter } from '../modules/category/category.routes.js';
import { unitRouter } from '../modules/unit/unit.routes.js';
import { productRouter } from '../modules/product/product.routes.js';
import { customerRouter } from '../modules/customer/customer.routes.js';
import { saleRouter } from '../modules/sale/sale.routes.js';
import { paymentRouter } from '../modules/payment/payment.routes.js';
import { deliveryRouter } from '../modules/delivery/delivery.routes.js';
import { reportRouter } from '../modules/report/report.routes.js';
import { publicRouter } from '../modules/public/public.routes.js';
import { expenseRouter } from '../modules/expense/expense.routes.js';
import { conversionRouter } from '../modules/conversion/conversion.routes.js';
import { uploadRouter } from '../modules/upload/upload.routes.js';

/** Versioned API router (§33). Feature routers are mounted here per phase. */
export const apiV1 = Router();

apiV1.get('/', (_req, res) => res.json({ success: true, data: { name: 'Ghanipur API', version: 'v1' } }));
apiV1.use('/auth', authRouter);
apiV1.use('/admin', adminAuthRouter);
apiV1.use('/super-admin', superAdminAuthRouter);
apiV1.use('/shops', shopRouter);
apiV1.use('/staff', staffRouter);
apiV1.use('/categories', categoryRouter);
apiV1.use('/units', unitRouter);
apiV1.use('/products', productRouter);
apiV1.use('/customers', customerRouter);
apiV1.use('/sales', saleRouter);
apiV1.use('/payments', paymentRouter);
apiV1.use('/deliveries', deliveryRouter);
apiV1.use('/reports', reportRouter);
apiV1.use('/expenses', expenseRouter);
apiV1.use('/conversions', conversionRouter);
apiV1.use('/uploads', uploadRouter);
apiV1.use('/public', publicRouter);
