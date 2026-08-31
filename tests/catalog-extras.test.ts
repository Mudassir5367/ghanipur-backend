import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function setup(): Promise<{ owner: TestActor; unitId: string; categoryId: string }> {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  return { owner, unitId, categoryId: cat.body.data.category._id };
}

describe('SKU generation (§4)', () => {
  it('suggests a clean, unique SKU derived from the category', async () => {
    const { owner, categoryId } = await setup();
    const res = await request(app).get(`/api/v1/products/sku/suggest?categoryId=${categoryId}`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.sku).toMatch(/^MILK-\d{4}$/);
  });

  it('keeps SKUs unique even when the same value is submitted twice', async () => {
    const { owner, unitId, categoryId } = await setup();
    const a = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Milk A', categoryId, unitId, sellingPrice: 200, purchaseCost: 160, sku: 'MILK-0001' });
    const b = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Milk B', categoryId, unitId, sellingPrice: 200, purchaseCost: 160, sku: 'MILK-0001' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.product.sku).not.toBe(b.body.data.product.sku); // de-duplicated
  });
});

describe('Category duplicate prevention (§3)', () => {
  it('rejects a duplicate category name (case-insensitive)', async () => {
    const owner = await registerShop(app);
    await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Butter' });
    const dup = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'butter' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CATEGORY_EXISTS');
  });
});

describe('Product image upload (§8)', () => {
  it('uploads an image and attaches it to a product', async () => {
    const { owner, unitId, categoryId } = await setup();
    const up = await request(app).post('/api/v1/uploads').set(auth(owner.token)).attach('file', PNG, { filename: 'milk.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    expect(up.body.data.url).toMatch(/\/uploads\/.+\.png$/);

    const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Milk', categoryId, unitId, sellingPrice: 250, purchaseCost: 200, images: [up.body.data.url] });
    expect(prod.status).toBe(201);
    expect(prod.body.data.product.images[0]).toBe(up.body.data.url);
  });

  it('rejects non-image uploads', async () => {
    const owner = await registerShop(app);
    const up = await request(app).post('/api/v1/uploads').set(auth(owner.token)).attach('file', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(up.status).toBe(400);
  });
});
