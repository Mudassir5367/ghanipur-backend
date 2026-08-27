import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, createSuperAdmin, auth } from './helpers.js';

const app = createApp();

async function activeShopWithProduct() {
  const owner = await registerShop(app, { shopName: 'Ali Dairy' });
  const su = await createSuperAdmin(app);
  await request(app).patch(`/api/v1/shops/${owner.shopId}/status`).set(auth(su.token)).send({ status: 'ACTIVE' });

  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Buffalo Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice: 250, purchaseCost: 210, openingStock: 50 });
  return { owner, productSlug: prod.body.data.product.slug };
}

describe('Public storefront (§27, §43)', () => {
  it('lists only ACTIVE shops', async () => {
    await registerShop(app, { email: 'pending@test.com', shopName: 'Pending Shop' }); // stays PENDING
    await activeShopWithProduct();
    const res = await request(app).get('/api/v1/public/shops');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].slug).toBe('ali-dairy');
  });

  it('serves a shop storefront with categories, no auth required', async () => {
    await activeShopWithProduct();
    const res = await request(app).get('/api/v1/public/shops/ali-dairy');
    expect(res.status).toBe(200);
    expect(res.body.data.shop.name).toBe('Ali Dairy');
    expect(res.body.data.categories.length).toBe(1);
  });

  it('lists products WITHOUT leaking purchase cost', async () => {
    const { productSlug } = await activeShopWithProduct();
    const list = await request(app).get('/api/v1/public/shops/ali-dairy/products');
    expect(list.status).toBe(200);
    expect(list.body.data.products.length).toBe(1);
    expect(list.body.data.products[0].sellingPriceMinor).toBe(25000);
    expect(list.body.data.products[0].purchaseCostMinor).toBeUndefined(); // never exposed

    const detail = await request(app).get(`/api/v1/public/shops/ali-dairy/products/${productSlug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.product.purchaseCostMinor).toBeUndefined();
  });

  it('404s a pending/suspended shop on the storefront', async () => {
    await registerShop(app, { email: 'x@test.com', shopName: 'Hidden' }); // PENDING
    const res = await request(app).get('/api/v1/public/shops/hidden');
    expect(res.status).toBe(404);
  });
});
