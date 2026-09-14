import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();

async function setup() {
  const owner = await registerShop(app);
  const units = (await request(app).get('/api/v1/units').set(auth(owner.token))).body.data;
  const L = units.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const kg = units.find((u: { symbol: string }) => u.symbol === 'kg')._id;
  const cat = async (name: string) => (await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name })).body.data.category._id;
  const [milkCat, yogurtCat, gheeCat] = [await cat('Milk'), await cat('Yogurt'), await cat('Desi Ghee')];
  const product = async (body: Record<string, unknown>) =>
    (await request(app).post('/api/v1/products').set(auth(owner.token)).send(body)).body.data.product._id as string;

  return {
    owner,
    milk: await product({ name: 'Milk', categoryId: milkCat, unitId: L, sellingPrice: 250, purchaseCost: 200, openingStock: 150 }),
    // Sweet Milk sits in the Milk category but must never be offered as a source.
    sweet: await product({ name: 'Sweet Milk', categoryId: milkCat, unitId: L, sellingPrice: 280, purchaseCost: 230, openingStock: 0 }),
    yogurt: await product({ name: 'Yogurt', categoryId: yogurtCat, unitId: kg, sellingPrice: 300, purchaseCost: 240, openingStock: 10 }),
    ghee: await product({ name: 'Desi Ghee', categoryId: gheeCat, unitId: kg, sellingPrice: 2600, purchaseCost: 2200, openingStock: 5 }),
  };
}

const productOf = async (owner: TestActor, id: string) =>
  (await request(app).get(`/api/v1/products/${id}`).set(auth(owner.token))).body.data.product;
const convert = (owner: TestActor, body: Record<string, unknown>) =>
  request(app).post('/api/v1/conversions').set(auth(owner.token)).send(body);

describe('Conversion (Milk → Sweet Milk / Yogurt)', () => {
  it('offers only Milk as the source and Sweet Milk / Yogurt as outputs', async () => {
    const { owner, milk, sweet, yogurt } = await setup();
    const res = await request(app).get('/api/v1/conversions/options').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.rate).toBe(0.96);
    expect(res.body.data.milk.map((p: { _id: string }) => p._id)).toEqual([milk]);
    expect(res.body.data.outputs.SWEET_MILK.map((p: { _id: string }) => p._id)).toEqual([sweet]);
    expect(res.body.data.outputs.YOGURT.map((p: { _id: string }) => p._id)).toEqual([yogurt]);
  });

  it('deducts the entered Milk, adds 96% to the output, and changes no price', async () => {
    const { owner, milk, yogurt } = await setup();
    const res = await convert(owner, { sourceProductId: milk, targetProductId: yogurt, quantity: 100 });
    expect(res.status).toBe(201);

    const c = res.body.data.conversion;
    expect(c.sourceQuantity).toBe(100);
    expect(c.convertedQuantity).toBe(96);
    expect(c.outputKind).toBe('YOGURT');
    expect(c.unitSymbol).toBe('L');
    expect(c.targetUnitSymbol).toBe('kg');
    // Existing cost calculation: 100 × Rs 250 = Rs 25,000 over 96 → Rs 260.42 each.
    expect(c.totalValueMinor).toBe(2500000);
    expect(c.convertedUnitPriceMinor).toBe(Math.round(2500000 / 96));

    const [m, y] = [await productOf(owner, milk), await productOf(owner, yogurt)];
    expect(m.currentStock).toBe(50);
    expect(y.currentStock).toBe(106);
    // The cost is reference only: no selling or purchase price moved.
    expect(y.sellingPriceMinor).toBe(30000);
    expect(y.purchaseCostMinor).toBe(24000);
    expect(m.sellingPriceMinor).toBe(25000);
  });

  it('converts Milk to Sweet Milk', async () => {
    const { owner, milk, sweet } = await setup();
    const res = await convert(owner, { sourceProductId: milk, targetProductId: sweet, quantity: 50 });
    expect(res.status).toBe(201);
    expect(res.body.data.conversion.outputKind).toBe('SWEET_MILK');
    expect((await productOf(owner, sweet)).currentStock).toBe(48);
    expect((await productOf(owner, sweet)).sellingPriceMinor).toBe(28000);
  });

  it('rejects anything other than Milk → Sweet Milk / Yogurt', async () => {
    const { owner, milk, sweet, yogurt, ghee } = await setup();
    const notMilk = await convert(owner, { sourceProductId: ghee, targetProductId: yogurt, quantity: 1 });
    expect(notMilk.status).toBe(400);
    expect(notMilk.body.code).toBe('SOURCE_NOT_MILK');

    const sweetAsSource = await convert(owner, { sourceProductId: sweet, targetProductId: yogurt, quantity: 1 });
    expect(sweetAsSource.body.code).toBe('SOURCE_NOT_MILK');

    const badOutput = await convert(owner, { sourceProductId: milk, targetProductId: ghee, quantity: 1 });
    expect(badOutput.status).toBe(400);
    expect(badOutput.body.code).toBe('TARGET_NOT_ALLOWED');
    expect((await productOf(owner, milk)).currentStock).toBe(150); // nothing moved
  });

  it('cannot convert more Milk than is in stock, and leaves both stocks unchanged', async () => {
    const { owner, milk, yogurt } = await setup();
    const res = await convert(owner, { sourceProductId: milk, targetProductId: yogurt, quantity: 500 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await productOf(owner, milk)).currentStock).toBe(150);
    expect((await productOf(owner, yogurt)).currentStock).toBe(10);
  });

  it('keeps a dated history with period totals', async () => {
    const { owner, milk, sweet, yogurt } = await setup();
    await convert(owner, { sourceProductId: milk, targetProductId: yogurt, quantity: 100 });
    await convert(owner, { sourceProductId: milk, targetProductId: sweet, quantity: 25 });

    const now = new Date();
    const today = { from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), to: new Date(now.getTime() + 60 * 60 * 1000).toISOString() };
    const list = await request(app).get('/api/v1/conversions').query(today).set(auth(owner.token));
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data[0].performedByName).toBeTruthy();

    const lastWeek = { from: new Date(now.getTime() - 9 * 864e5).toISOString(), to: new Date(now.getTime() - 8 * 864e5).toISOString() };
    const none = await request(app).get('/api/v1/conversions').query(lastWeek).set(auth(owner.token));
    expect(none.body.meta.total).toBe(0);

    const summary = await request(app).get('/api/v1/conversions/summary').query(today).set(auth(owner.token));
    expect(summary.status).toBe(200);
    expect(summary.body.data.count).toBe(2);
    expect(summary.body.data.milkUsed).toEqual([{ unitSymbol: 'L', quantity: 125 }]);
    const produced = Object.fromEntries(summary.body.data.produced.map((p: { outputKind: string; quantity: number }) => [p.outputKind, p.quantity]));
    expect(produced).toEqual({ YOGURT: 96, SWEET_MILK: 24 });
    expect(summary.body.data.totalCostMinor).toBe(125 * 25000);

    const bad = await request(app).get('/api/v1/conversions?from=not-a-date').set(auth(owner.token));
    expect(bad.status).toBe(400);
  });
});
