import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();

async function setup(openingStock = 100) {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const categoryId = cat.body.data.category._id;
  const milk = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Buffalo Milk', categoryId, unitId, sellingPrice: 250, purchaseCost: 200, openingStock });
  const cow = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Cow Milk', categoryId, unitId, sellingPrice: 200, purchaseCost: 150, openingStock });
  return { owner, productId: milk.body.data.product._id as string, cowId: cow.body.data.product._id as string };
}

async function makeCustomer(owner: TestActor, name = 'Muhammad Ali') {
  const res = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name, phone: `0300${Math.floor(Math.random() * 1e7)}`, type: 'HOTEL' });
  return res.body.data.customer._id as string;
}

const stockOf = async (owner: TestActor, productId: string) =>
  (await request(app).get(`/api/v1/products/${productId}`).set(auth(owner.token))).body.data.product.currentStock;
const balanceOf = async (owner: TestActor, customerId: string) =>
  (await request(app).get(`/api/v1/customers/${customerId}`).set(auth(owner.token))).body.data.customer.currentBalanceMinor;
const dashboard = async (owner: TestActor) =>
  (await request(app).get('/api/v1/reports/dashboard').set(auth(owner.token))).body.data;
const saleOf = async (owner: TestActor, id: string) =>
  (await request(app).get(`/api/v1/sales/${id}`).set(auth(owner.token))).body.data;
const edit = (owner: TestActor, id: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/v1/sales/${id}`).set(auth(owner.token)).send(body);

describe('Editing a confirmed sale', () => {
  it('changes a mistaken Cash sale to Credit, and the dashboard follows', async () => {
    const { owner, productId } = await setup();
    const customerId = await makeCustomer(owner);
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', customerId, items: [{ productId, quantity: 10 }] });
    const sale = created.body.data.sale;

    let dash = await dashboard(owner);
    expect(dash.sales.cashMinor).toBe(250000);
    expect(dash.sales.creditMinor).toBe(0);

    const res = await edit(owner, sale._id, { type: 'CREDIT', customerId, items: [{ productId, quantity: 10, unitPrice: 250 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.sale.type).toBe('CREDIT');
    expect(res.body.data.sale.paidMinor).toBe(0);
    expect(res.body.data.sale.dueMinor).toBe(250000);
    expect(res.body.data.sale.code).toBe(sale.code); // same receipt
    expect(res.body.data.sale.soldAt).toBe(sale.soldAt); // same day

    dash = await dashboard(owner);
    expect(dash.sales.cashMinor).toBe(0);
    expect(dash.sales.creditMinor).toBe(250000);
    expect(dash.outstandingMinor).toBe(250000);
    expect(await balanceOf(owner, customerId)).toBe(250000);
    expect(await stockOf(owner, productId)).toBe(90); // type change moves no stock

    // Filtering by type finds it under its new type only.
    const credit = await request(app).get('/api/v1/sales?type=CREDIT').set(auth(owner.token));
    const cash = await request(app).get('/api/v1/sales?type=CASH').set(auth(owner.token));
    expect(credit.body.data.map((s: { _id: string }) => s._id)).toContain(sale._id);
    expect(cash.body.data.map((s: { _id: string }) => s._id)).not.toContain(sale._id);
  });

  it('changes Credit back to Cash, clearing the customer charge with an audit trail', async () => {
    const { owner, productId } = await setup();
    const customerId = await makeCustomer(owner);
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 4 }] });
    expect(await balanceOf(owner, customerId)).toBe(100000);

    const res = await edit(owner, created.body.data.sale._id, { type: 'CASH', customerId, items: [{ productId, quantity: 4, unitPrice: 250 }] });
    expect(res.status).toBe(200);
    expect(await balanceOf(owner, customerId)).toBe(0);
    const dash = await dashboard(owner);
    expect(dash.sales.cashMinor).toBe(100000);
    expect(dash.sales.creditMinor).toBe(0);
    expect(dash.outstandingMinor).toBe(0);

    const ledger = await request(app).get(`/api/v1/customers/${customerId}/ledger`).set(auth(owner.token));
    const types = ledger.body.data.entries.map((e: { entryType: string }) => e.entryType).sort();
    expect(types).toEqual(['CREDIT_SALE', 'REVERSAL']);
  });

  it('edits lines: stock moves by the net change and totals/quantities update', async () => {
    const { owner, productId, cowId } = await setup();
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 10 }] });

    const res = await edit(owner, created.body.data.sale._id, {
      type: 'CASH',
      items: [{ productId, quantity: 4, unitPrice: 250 }, { productId: cowId, quantity: 3, unitPrice: 200 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.sale.totalMinor).toBe(4 * 25000 + 3 * 20000);

    expect(await stockOf(owner, productId)).toBe(96); // 6 given back
    expect(await stockOf(owner, cowId)).toBe(97); // 3 newly taken

    const { items } = await saleOf(owner, created.body.data.sale._id);
    expect(items.map((i: { name: string; quantity: number }) => `${i.name}:${i.quantity}`).sort()).toEqual(['Buffalo Milk:4', 'Cow Milk:3']);

    const dash = await dashboard(owner);
    expect(dash.sales.totalMinor).toBe(160000);
    expect(dash.qtySold).toBe(7);
  });

  it('moves a credit charge to a different customer', async () => {
    const { owner, productId } = await setup();
    const ali = await makeCustomer(owner, 'Ali');
    const bilal = await makeCustomer(owner, 'Bilal');
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId: ali, items: [{ productId, quantity: 2 }] });

    const res = await edit(owner, created.body.data.sale._id, { type: 'CREDIT', customerId: bilal, items: [{ productId, quantity: 2, unitPrice: 250 }] });
    expect(res.status).toBe(200);
    expect(await balanceOf(owner, ali)).toBe(0);
    expect(await balanceOf(owner, bilal)).toBe(50000);
  });

  it('keeps an amount-based line exact when only the type changes', async () => {
    const { owner, productId } = await setup();
    // Rs 100 of milk at Rs 250/L → 0.4 L, total exactly Rs 100.
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, amount: 100 }] });
    const res = await edit(owner, created.body.data.sale._id, { type: 'CREDIT', items: [{ productId, amount: 100, unitPrice: 250 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.sale.totalMinor).toBe(10000);
    expect(await stockOf(owner, productId)).toBe(99.6);
  });

  it('leaves the stock ledger untouched when quantities do not change', async () => {
    const { owner, productId } = await setup();
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 5 }] });
    const before = (await request(app).get(`/api/v1/products/${productId}/inventory`).set(auth(owner.token))).body.data.length;

    const res = await edit(owner, created.body.data.sale._id, { type: 'CASH', items: [{ productId, quantity: 5, unitPrice: 240 }], note: 'price fix' });
    expect(res.status).toBe(200);
    expect(res.body.data.sale.totalMinor).toBe(120000);
    const after = (await request(app).get(`/api/v1/products/${productId}/inventory`).set(auth(owner.token))).body.data.length;
    expect(after).toBe(before);
  });

  it('rejects an edit needing more stock than exists, changing nothing', async () => {
    const { owner, productId } = await setup(20);
    const customerId = await makeCustomer(owner);
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 5 }] });
    const saleId = created.body.data.sale._id;

    const res = await edit(owner, saleId, { type: 'CASH', customerId, items: [{ productId, quantity: 50, unitPrice: 250 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');

    const { sale, items } = await saleOf(owner, saleId);
    expect(sale.type).toBe('CREDIT');
    expect(sale.totalMinor).toBe(125000);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(5);
    expect(await stockOf(owner, productId)).toBe(15);
    expect(await balanceOf(owner, customerId)).toBe(125000);
  });

  it('refuses to edit a reversed sale', async () => {
    const { owner, productId } = await setup();
    const created = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 1 }] });
    await request(app).post(`/api/v1/sales/${created.body.data.sale._id}/reverse`).set(auth(owner.token));
    const res = await edit(owner, created.body.data.sale._id, { type: 'CREDIT', items: [{ productId, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SALE_NOT_EDITABLE');
  });

  it("cannot edit another shop's sale", async () => {
    const a = await setup();
    const b = await setup();
    const created = await request(app).post('/api/v1/sales').set(auth(a.owner.token)).send({ type: 'CASH', items: [{ productId: a.productId, quantity: 1 }] });
    const res = await edit(b.owner, created.body.data.sale._id, { type: 'CREDIT', items: [{ productId: b.productId, quantity: 1 }] });
    expect(res.status).toBe(404);
  });
});
