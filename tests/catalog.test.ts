import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();

async function getLitreUnitId(token: string): Promise<string> {
  const res = await request(app).get('/api/v1/units').set(auth(token));
  const litre = res.body.data.find((u: { symbol: string }) => u.symbol === 'L');
  return litre._id;
}

async function makeCategory(token: string, name = 'Milk'): Promise<string> {
  const res = await request(app).post('/api/v1/categories').set(auth(token)).send({ name });
  return res.body.data.category._id;
}

async function makeProduct(actor: TestActor, over: Record<string, unknown> = {}): Promise<string> {
  const unitId = await getLitreUnitId(actor.token);
  const categoryId = await makeCategory(actor.token, `Cat_${Math.random().toString(36).slice(2, 6)}`);
  const res = await request(app)
    .post('/api/v1/products')
    .set(auth(actor.token))
    .send({ name: 'Fresh Milk', categoryId, unitId, sellingPrice: 250, purchaseCost: 210, openingStock: 46, ...over });
  return res.body.data.product._id;
}

describe('Units', () => {
  it('provides shared default units and allows custom units', async () => {
    const owner = await registerShop(app);
    const res = await request(app).get('/api/v1/units').set(auth(owner.token));
    expect(res.status).toBe(200);
    const symbols = res.body.data.map((u: { symbol: string }) => u.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['L', 'kg', 'pc']));

    const custom = await request(app).post('/api/v1/units').set(auth(owner.token)).send({ name: 'Panda', symbol: 'pnd', kind: 'VOLUME' });
    expect(custom.status).toBe(201);
  });
});

describe('Categories', () => {
  it('creates, lists, and nests categories', async () => {
    const owner = await registerShop(app);
    const dairy = await makeCategory(owner.token, 'Dairy');
    const milk = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk', parentId: dairy });
    expect(milk.status).toBe(201);
    expect(milk.body.data.category.parentId).toBe(dairy);
    expect(milk.body.data.category.slug).toBe('milk');

    const list = await request(app).get('/api/v1/categories').set(auth(owner.token));
    expect(list.body.data.length).toBe(2);
  });

  it('blocks deleting a category that has products', async () => {
    const owner = await registerShop(app);
    const unitId = await getLitreUnitId(owner.token);
    const categoryId = await makeCategory(owner.token, 'Milk');
    await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Cow Milk', categoryId, unitId, sellingPrice: 200, purchaseCost: 160 });

    const del = await request(app).delete(`/api/v1/categories/${categoryId}`).set(auth(owner.token));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('CATEGORY_HAS_PRODUCTS');
  });
});

describe('Products & inventory', () => {
  it('creates a product with opening stock recorded in the ledger', async () => {
    const owner = await registerShop(app);
    const productId = await makeProduct(owner);
    const res = await request(app).get(`/api/v1/products/${productId}`).set(auth(owner.token));
    expect(res.body.data.product.currentStock).toBe(46);
    expect(res.body.data.product.sellingPriceMinor).toBe(25000); // Rs 250 -> paisa

    const ledger = await request(app).get(`/api/v1/products/${productId}/inventory`).set(auth(owner.token));
    expect(ledger.body.data.length).toBe(1);
    expect(ledger.body.data[0].type).toBe('STOCK_IN');
    expect(ledger.body.data[0].balanceAfter).toBe(46);
  });

  it('records stock-in, wastage and adjustment movements', async () => {
    const owner = await registerShop(app);
    const productId = await makeProduct(owner); // stock 46

    const stockIn = await request(app).post(`/api/v1/products/${productId}/inventory`).set(auth(owner.token)).send({ type: 'STOCK_IN', quantity: 10 });
    expect(stockIn.body.data.currentStock).toBe(56);

    const wastage = await request(app).post(`/api/v1/products/${productId}/inventory`).set(auth(owner.token)).send({ type: 'WASTAGE', quantity: 6 });
    expect(wastage.body.data.currentStock).toBe(50);

    const adjust = await request(app).post(`/api/v1/products/${productId}/inventory`).set(auth(owner.token)).send({ type: 'ADJUSTMENT', quantity: -5, note: 'spillage correction' });
    expect(adjust.body.data.currentStock).toBe(45);
  });

  it('rejects wastage exceeding available stock', async () => {
    const owner = await registerShop(app);
    const productId = await makeProduct(owner); // stock 46
    const res = await request(app).post(`/api/v1/products/${productId}/inventory`).set(auth(owner.token)).send({ type: 'WASTAGE', quantity: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('filters low-stock products', async () => {
    const owner = await registerShop(app);
    const unitId = await getLitreUnitId(owner.token);
    const categoryId = await makeCategory(owner.token, 'Milk');
    await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Low', categoryId, unitId, sellingPrice: 100, purchaseCost: 80, minStock: 10, openingStock: 5 });
    await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'High', categoryId, unitId, sellingPrice: 100, purchaseCost: 80, minStock: 10, openingStock: 50 });

    const low = await request(app).get('/api/v1/products?lowStock=true').set(auth(owner.token));
    expect(low.body.data.length).toBe(1);
    expect(low.body.data[0].name).toBe('Low');
  });
});
