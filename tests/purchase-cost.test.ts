import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createApp } from '../src/app.js';
import { ddb } from '../src/config/dynamo.js';
import { TABLES } from '../src/config/dynamoTables.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();

async function setup(product: Record<string, unknown> = {}) {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'kg')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const res = await request(app).post('/api/v1/products').set(auth(owner.token))
    .send({ name: 'Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice: 250, purchaseCost: 170, ...product });
  expect(res.status).toBe(201);
  const cust = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name: 'Ahmed', phone: '03001234567' });
  return { owner, productId: res.body.data.product._id as string, created: res.body.data.product, customerId: cust.body.data.customer._id as string };
}

const productOf = async (owner: TestActor, id: string) =>
  (await request(app).get(`/api/v1/products/${id}`).set(auth(owner.token))).body.data.product;
const stockIn = (owner: TestActor, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/v1/products/${id}/inventory`).set(auth(owner.token)).send({ type: 'STOCK_IN', ...body });
const profitToday = async (owner: TestActor) =>
  (await request(app).get('/api/v1/reports/profit-loss').set(auth(owner.token))).body.data.daily.profitMinor as number;

describe('Product & stock purchases', () => {
  it('Add Product records the supplier and costs opening stock as the first purchase', async () => {
    const { owner, productId, created } = await setup({ supplier: 'Rehman Dairy Farm', openingStock: 20 });
    expect(created.supplier).toBe('Rehman Dairy Farm');
    expect(created.avgCostMinor).toBe(17000);

    const ledger = await request(app).get(`/api/v1/products/${productId}/inventory`).set(auth(owner.token));
    expect(ledger.body.data[0]).toMatchObject({ type: 'STOCK_IN', supplier: 'Rehman Dairy Farm', unitCostMinor: 17000 });
  });

  it('averages the same product bought from different suppliers at different costs, by quantity', async () => {
    const { owner, productId } = await setup(); // no opening stock → average falls back to Cost Price
    expect((await productOf(owner, productId)).avgCostMinor).toBe(17000);

    const a = await stockIn(owner, productId, { quantity: 10, supplier: 'A', unitCost: 178 });
    expect(a.status).toBe(200);
    expect(a.body.data.avgCostMinor).toBe(17800);

    await stockIn(owner, productId, { quantity: 30, supplier: 'B', unitCost: 175 });
    const p = await productOf(owner, productId);
    expect(p.avgCostMinor).toBe(Math.round((10 * 17800 + 30 * 17500) / 40)); // 175.75, not the plain 176.50
    expect(p.currentStock).toBe(40);
    expect(p.purchaseCostMinor).toBe(17000); // the entered Cost Price itself is unchanged

    const ledger = await request(app).get(`/api/v1/products/${productId}/inventory`).set(auth(owner.token));
    const purchases = ledger.body.data.map((t: { supplier?: string; unitCostMinor?: number }) => `${t.supplier}@${t.unitCostMinor}`).sort();
    expect(purchases).toEqual(['A@17800', 'B@17500']);
  });

  it('includes opening stock in the average', async () => {
    const { owner, productId } = await setup({ openingStock: 20 }); // 20 @ 170
    await stockIn(owner, productId, { quantity: 20, supplier: 'A', unitCost: 180 });
    expect((await productOf(owner, productId)).avgCostMinor).toBe(17500);
  });

  it('costs a stock-in without a cost price (older clients) at the Cost Price', async () => {
    const { owner, productId } = await setup();
    await stockIn(owner, productId, { quantity: 10, unitCost: 200 });
    await stockIn(owner, productId, { quantity: 10 }); // no unitCost
    expect((await productOf(owner, productId)).avgCostMinor).toBe(18500);
  });

  it('is not moved by wastage, returns or adjustments', async () => {
    const { owner, productId } = await setup();
    await stockIn(owner, productId, { quantity: 50, supplier: 'A', unitCost: 180 });
    const move = (type: string, quantity: number) =>
      request(app).post(`/api/v1/products/${productId}/inventory`).set(auth(owner.token)).send({ type, quantity, unitCost: 1 });
    await move('WASTAGE', 5);
    await move('RETURN', 2);
    await move('ADJUSTMENT', -3);
    expect((await productOf(owner, productId)).avgCostMinor).toBe(18000);
  });

  it('adjusts the average when opening stock is corrected', async () => {
    const { owner, productId } = await setup({ openingStock: 20 }); // 20 @ 170
    await stockIn(owner, productId, { quantity: 20, supplier: 'A', unitCost: 180 }); // avg 175
    await request(app).patch(`/api/v1/products/${productId}`).set(auth(owner.token)).send({ openingStock: 40 });
    expect((await productOf(owner, productId)).avgCostMinor).toBe(Math.round((40 * 17000 + 20 * 18000) / 60));
  });

  it('suggests suppliers already used', async () => {
    const { owner, productId } = await setup({ supplier: 'Rehman Dairy' });
    await stockIn(owner, productId, { quantity: 1, supplier: 'A', unitCost: 178 });
    await stockIn(owner, productId, { quantity: 1, supplier: 'a', unitCost: 178 }); // same name, different case
    const res = await request(app).get('/api/v1/products/suppliers').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.suppliers).toEqual(['A', 'Rehman Dairy']);
  });
});

describe('Average cost in Sales', () => {
  it('costs a sale at the average, and later purchases do not change past profit', async () => {
    const { owner, productId } = await setup();
    await stockIn(owner, productId, { quantity: 10, supplier: 'A', unitCost: 178 });
    await stockIn(owner, productId, { quantity: 30, supplier: 'B', unitCost: 175 }); // avg 175.75

    const sale = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 4 }] });
    const saleId = sale.body.data.sale._id;
    const { items } = (await request(app).get(`/api/v1/sales/${saleId}`).set(auth(owner.token))).body.data;
    expect(items[0].unitCostMinor).toBe(17575);
    expect(await profitToday(owner)).toBe(4 * 25000 - 4 * 17575);

    await stockIn(owner, productId, { quantity: 40, supplier: 'C', unitCost: 240 }); // average jumps
    expect(await profitToday(owner)).toBe(4 * 25000 - 4 * 17575); // the sale keeps its cost

    // Editing the sale (e.g. Cash → Credit) keeps the cost it was sold at.
    await request(app).patch(`/api/v1/sales/${saleId}`).set(auth(owner.token)).send({ type: 'CREDIT', items: [{ productId, quantity: 4, unitPrice: 250 }] });
    expect(await profitToday(owner)).toBe(4 * 25000 - 4 * 17575);
  });

  it('keeps products made before purchase costing exactly as they were, until their next purchase', async () => {
    const { owner, productId } = await setup({ openingStock: 20 }); // 20 @ 170
    // Simulate a product saved before purchase costing existed: no running totals.
    await ddb.send(new UpdateCommand({
      TableName: TABLES.Product as string,
      Key: { shopId: owner.shopId!, id: productId },
      UpdateExpression: 'REMOVE costBasisQty, costBasisMinor',
    }));
    expect((await productOf(owner, productId)).avgCostMinor).toBe(17000); // = Cost Price, as before

    await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 2 }] });
    expect(await profitToday(owner)).toBe(2 * (25000 - 17000));

    // First costed purchase folds in the earlier purchases (opening 20 @ 170).
    await stockIn(owner, productId, { quantity: 10, supplier: 'A', unitCost: 200 });
    expect((await productOf(owner, productId)).avgCostMinor).toBe(18000); // (20×170 + 10×200) / 30
  });
});

describe('Deliveries are unaffected', () => {
  it('still default a delivery line to the Cost Price, not the average', async () => {
    const { owner, productId, customerId } = await setup({ openingStock: 10 });
    await stockIn(owner, productId, { quantity: 30, supplier: 'A', unitCost: 190 }); // average now differs
    const d = await request(app).post('/api/v1/deliveries').set(auth(owner.token)).send({ customerId, lines: [{ productId, quantity: 2 }], paymentType: 'CASH' });
    expect(d.status).toBe(201);
    expect(d.body.data.delivery.lines[0].costPriceMinor).toBe(17000);
    expect(d.body.data.delivery.costPriceMinor).toBe(2 * 17000);
  });
});
