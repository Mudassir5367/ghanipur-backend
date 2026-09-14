import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();

async function setup() {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice: 200, purchaseCost: 175, openingStock: 1000 });
  const cust = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name: 'Ahmed', phone: '03001234567' });
  return { owner, productId: prod.body.data.product._id as string, customerId: cust.body.data.customer._id as string };
}

/** The dashboard's "Today's Sales" block. */
const today = async (owner: TestActor) =>
  (await request(app).get('/api/v1/reports/dashboard').set(auth(owner.token))).body.data.salesValue as {
    totalMinor: number; salesMinor: number; deliveriesMinor: number; saleCount: number; deliveryCount: number;
  };
const sale = (owner: TestActor, body: Record<string, unknown>) => request(app).post('/api/v1/sales').set(auth(owner.token)).send(body);
const delivery = (owner: TestActor, body: Record<string, unknown>) => request(app).post('/api/v1/deliveries').set(auth(owner.token)).send(body);

describe("Today's Sales", () => {
  it('counts a cash sale at its total', async () => {
    const { owner, productId } = await setup();
    await sale(owner, { type: 'CASH', items: [{ productId, quantity: 1 }] });
    expect(await today(owner)).toMatchObject({ totalMinor: 20000, saleCount: 1, deliveryCount: 0 });
  });

  it('counts a credit sale once — its due is not added on top (walk-in or customer)', async () => {
    const { owner, productId, customerId } = await setup();
    await sale(owner, { type: 'CREDIT', items: [{ productId, quantity: 1 }] }); // walk-in, unassigned due
    expect((await today(owner)).totalMinor).toBe(20000);
    await sale(owner, { type: 'CREDIT', customerId, items: [{ productId, quantity: 1 }] });
    expect((await today(owner)).totalMinor).toBe(40000);
  });

  it('is unchanged when a sale is edited Cash → Credit and back', async () => {
    const { owner, productId } = await setup();
    const s = (await sale(owner, { type: 'CASH', items: [{ productId, quantity: 1 }] })).body.data.sale;
    await request(app).patch(`/api/v1/sales/${s._id}`).set(auth(owner.token)).send({ type: 'CREDIT', items: [{ productId, quantity: 1, unitPrice: 200 }] });
    expect((await today(owner)).totalMinor).toBe(20000);
    await request(app).patch(`/api/v1/sales/${s._id}`).set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 1, unitPrice: 200 }] });
    expect((await today(owner)).totalMinor).toBe(20000);
  });

  it('follows an edited quantity or price', async () => {
    const { owner, productId } = await setup();
    const s = (await sale(owner, { type: 'CREDIT', items: [{ productId, quantity: 1 }] })).body.data.sale;
    await request(app).patch(`/api/v1/sales/${s._id}`).set(auth(owner.token)).send({ type: 'CREDIT', items: [{ productId, quantity: 3, unitPrice: 210 }] });
    expect((await today(owner)).totalMinor).toBe(63000);
  });

  it('drops a reversed sale', async () => {
    const { owner, productId } = await setup();
    const s = (await sale(owner, { type: 'CREDIT', items: [{ productId, quantity: 2 }] })).body.data.sale;
    await sale(owner, { type: 'CASH', items: [{ productId, quantity: 1 }] });
    await request(app).post(`/api/v1/sales/${s._id}/reverse`).set(auth(owner.token));
    expect(await today(owner)).toMatchObject({ totalMinor: 20000, saleCount: 1 });
  });

  it('is not changed by a customer paying off credit', async () => {
    const { owner, productId, customerId } = await setup();
    await sale(owner, { type: 'CREDIT', customerId, items: [{ productId, quantity: 2 }] });
    await request(app).post('/api/v1/payments').set(auth(owner.token)).send({ customerId, amount: 400 });
    expect((await today(owner)).totalMinor).toBe(40000);
  });

  it('counts deliveries at full value whether paid, part-paid or unpaid', async () => {
    const { owner, productId, customerId } = await setup();
    await delivery(owner, { customerId, lines: [{ productId, quantity: 1 }], paymentType: 'CASH' }); // paid in full
    await delivery(owner, { customerId, lines: [{ productId, quantity: 2 }], paymentType: 'CREDIT', paidAmount: 100 }); // part-paid
    await delivery(owner, { customerId, lines: [{ productId, quantity: 3 }], paymentType: 'CREDIT' }); // unpaid
    expect(await today(owner)).toMatchObject({ totalMinor: 120000, deliveriesMinor: 120000, deliveryCount: 3 });
  });

  it('is not changed by a later delivery payment, and drops a cancelled delivery', async () => {
    const { owner, productId, customerId } = await setup();
    const d = (await delivery(owner, { customerId, lines: [{ productId, quantity: 2 }], paymentType: 'CREDIT' })).body.data.delivery;
    const gone = (await delivery(owner, { customerId, lines: [{ productId, quantity: 5 }], paymentType: 'CREDIT' })).body.data.delivery;

    await request(app).post(`/api/v1/deliveries/${d._id}/payments`).set(auth(owner.token)).send({ amount: 150 });
    expect((await today(owner)).totalMinor).toBe(140000);

    await request(app).patch(`/api/v1/deliveries/${gone._id}/status`).set(auth(owner.token)).send({ status: 'CANCELLED' });
    expect(await today(owner)).toMatchObject({ totalMinor: 40000, deliveryCount: 1 });
  });

  it('uses the delivery grand total (charges added, discount taken off)', async () => {
    const { owner, productId, customerId } = await setup();
    await delivery(owner, { customerId, lines: [{ productId, quantity: 2 }], paymentType: 'CASH', deliveryCharge: 50, discount: 30 });
    expect((await today(owner)).totalMinor).toBe(40000 + 5000 - 3000);
  });

  it('adds sales and deliveries together', async () => {
    const { owner, productId, customerId } = await setup();
    await sale(owner, { type: 'CASH', items: [{ productId, quantity: 1 }] });
    await sale(owner, { type: 'CREDIT', customerId, items: [{ productId, quantity: 1 }] });
    await delivery(owner, { customerId, lines: [{ productId, quantity: 1 }], paymentType: 'CREDIT' });
    expect(await today(owner)).toEqual({ totalMinor: 60000, salesMinor: 40000, deliveriesMinor: 20000, saleCount: 2, deliveryCount: 1 });
  });
});
