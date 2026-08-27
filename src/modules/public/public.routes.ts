import { Router } from 'express';
import type { Request, Response } from 'express';
import * as service from './public.service.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { validate } from '../../middlewares/validate.js';
import { slugParamSchema } from '../../utils/validators.js';
import { z } from 'zod';

// Public storefront — NO auth. Only ACTIVE shops and available products (§27).
export const publicRouter = Router();

// Public catalog can be cached by CDNs/browsers (§35). Financial/admin data never is.
publicRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  next();
});

const productParams = z.object({ slug: z.string().min(1).max(80), productSlug: z.string().min(1).max(80) });

publicRouter.get('/shops', asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listShops(req.query);
  ok(res, data, 200, meta);
}));

publicRouter.get('/shops/:slug', validate({ params: slugParamSchema }), asyncHandler(async (req: Request, res: Response) => {
  const { shop, categories } = await service.getShop(req.params.slug!);
  ok(res, { shop, categories });
}));

publicRouter.get('/shops/:slug/products', validate({ params: slugParamSchema }), asyncHandler(async (req: Request, res: Response) => {
  const { shop, data, meta } = await service.listProducts(req.params.slug!, req.query, {
    categoryId: req.query.categoryId as string | undefined,
    search: req.query.search as string | undefined,
  });
  ok(res, { shop, products: data }, 200, meta);
}));

publicRouter.get('/shops/:slug/products/:productSlug', validate({ params: productParams }), asyncHandler(async (req: Request, res: Response) => {
  const { shop, product } = await service.getProduct(req.params.slug!, req.params.productSlug!);
  ok(res, { shop, product });
}));
