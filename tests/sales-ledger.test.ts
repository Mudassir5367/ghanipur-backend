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
  const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Buffalo Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice: 250, purchaseCost: 200, openingStock });
  const productId = prod.body.data.product._id;
  return { owner, productId };
}

async function makeCustomer(owner: TestActor, name = 'Muhammad Ali') {
  const res = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name, phone: '03001234567', type: 'HOTEL' });
  return res.body.data.customer._id;
}

const stockOf = async (owner: TestActor, productId: string) =>
  (await request(app).get(`/api/v1/products/${productId}`).set(auth(owner.token))).body.data.product.currentStock;

const balanceOf = async (owner: TestActor, customerId: string) =>
  (await request(app).get(`/api/v1/customers/${customerId}`).set(auth(owner.token))).body.data.customer.currentBalanceMinor;

describe('Cash sale (§64)', () => {
  it('deducts stock, marks paid, and creates no ledger', async () => {
    const { owner, productId } = await setup();
    const res = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 10 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.sale.totalMinor).toBe(250 * 10 * 100);
    expect(res.body.data.sale.paidMinor).toBe(250 * 10 * 100);
    expect(res.body.data.sale.dueMinor).toBe(0);
    expect(await stockOf(owner, productId)).toBe(90);
  });
});

describe('Credit sale + ledger (§65, §12)', () => {
  it('deducts stock, debits the customer ledger, and raises outstanding', async () => {
    const { owner, productId } = await setup();
    const customerId = await makeCustomer(owner);

    // 5 L milk @ Rs 250 = Rs 1250 on credit
    const sale = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 5 }] });
    expect(sale.status).toBe(201);
    expect(sale.body.data.sale.dueMinor).toBe(125000);
    expect(await stockOf(owner, productId)).toBe(95);
    expect(await balanceOf(owner, customerId)).toBe(125000); // Rs 1250 outstanding

    // Customer pays Rs 500 -> remaining Rs 750 (§12, §66)
    const pay = await request(app).post('/api/v1/payments').set(auth(owner.token)).send({ customerId, amount: 500, method: 'CASH' });
    expect(pay.status).toBe(201);
    expect(pay.body.data.balanceAfterMinor).toBe(75000);
    expect(await balanceOf(owner, customerId)).toBe(75000);

    // Ledger shows sale debit + payment credit and running balance
    const ledger = await request(app).get(`/api/v1/customers/${customerId}/ledger`).set(auth(owner.token));
    expect(ledger.body.data.summary.outstandingMinor).toBe(75000);
    expect(ledger.body.data.entries.length).toBe(2);
  });

  it('allows a credit sale without a customer (unassigned due on the sale, not in customer outstanding)', async () => {
    const { owner, productId } = await setup(); // price 250, so 5 × 250 = Rs 1250
    const res = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', items: [{ productId, quantity: 5 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.sale.customerId ?? null).toBeNull();
    expect(res.body.data.sale.dueMinor).toBe(125000); // due tracked on the sale itself

    // But it belongs to no customer, so the dashboard "Outstanding" (which must
    // equal the sum of the customer rows) does NOT count it.
    const dash = await request(app).get('/api/v1/reports/dashboard').set(auth(owner.token));
    expect(dash.body.data.outstandingMinor).toBe(0);
  });
});

describe('Atomicity (§48)', () => {
  it('rolls back the ENTIRE sale when stock is insufficient', async () => {
    const { owner, productId } = await setup(5); // only 5 L
    const customerId = await makeCustomer(owner);
    const res = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');

    // Nothing partially applied: stock intact, no ledger, no sale
    expect(await stockOf(owner, productId)).toBe(5);
    expect(await balanceOf(owner, customerId)).toBe(0);
    const sales = await request(app).get('/api/v1/sales').set(auth(owner.token));
    expect(sales.body.data.length).toBe(0);
  });

  it('rolls back a multi-item sale if any one item lacks stock', async () => {
    const { owner, productId } = await setup(100);
    const units = await request(app).get('/api/v1/units').set(auth(owner.token));
    const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
    const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Ghee' });
    const p2 = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Ghee', categoryId: cat.body.data.category._id, unitId, sellingPrice: 2600, purchaseCost: 2200, openingStock: 2 });
    const p2Id = p2.body.data.product._id;

    const res = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 5 }, { productId: p2Id, quantity: 5 }] });
    expect(res.status).toBe(400);
    // First item must NOT have been deducted because the whole txn rolled back
    expect(await stockOf(owner, productId)).toBe(100);
    expect(await stockOf(owner, p2Id)).toBe(2);
  });
});

describe('Reversals (§79)', () => {
  it('reverses a credit sale: restores stock and credits the ledger back', async () => {
    const { owner, productId } = await setup(50);
    const customerId = await makeCustomer(owner);
    const sale = await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 10 }] });
    const saleId = sale.body.data.sale._id;
    expect(await balanceOf(owner, customerId)).toBe(250000);

    const rev = await request(app).post(`/api/v1/sales/${saleId}/reverse`).set(auth(owner.token));
    expect(rev.status).toBe(200);
    expect(rev.body.data.sale.status).toBe('CANCELLED');
    expect(await stockOf(owner, productId)).toBe(50); // stock restored
    expect(await balanceOf(owner, customerId)).toBe(0); // debt cleared

    // Double reverse is refused
    const again = await request(app).post(`/api/v1/sales/${saleId}/reverse`).set(auth(owner.token));
    expect(again.status).toBe(409);
  });

  it('reverses a payment, restoring the outstanding balance', async () => {
    const { owner, productId } = await setup(50);
    const customerId = await makeCustomer(owner);
    await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 4 }] }); // Rs 1000
    const pay = await request(app).post('/api/v1/payments').set(auth(owner.token)).send({ customerId, amount: 1000 });
    expect(await balanceOf(owner, customerId)).toBe(0);

    const rev = await request(app).post(`/api/v1/payments/${pay.body.data.payment._id}/reverse`).set(auth(owner.token));
    expect(rev.status).toBe(200);
    expect(await balanceOf(owner, customerId)).toBe(100000); // Rs 1000 owed again
  });
});

describe('Customer guards', () => {
  it('blocks deleting a customer who owes money', async () => {
    const { owner, productId } = await setup(50);
    const customerId = await makeCustomer(owner);
    await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 2 }] });
    const del = await request(app).delete(`/api/v1/customers/${customerId}`).set(auth(owner.token));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('CUSTOMER_HAS_BALANCE');
  });
});
