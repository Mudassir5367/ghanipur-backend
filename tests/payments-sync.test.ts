import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();
const D = '/api/v1/deliveries';

async function setup(sellingPrice = 500) {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice, purchaseCost: Math.round(sellingPrice * 0.8), openingStock: 1000 });
  const cust = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name: 'Delivery 1' });
  return { owner, productId: prod.body.data.product._id, customerId: cust.body.data.customer._id };
}

const customerRow = async (owner: TestActor, customerId: string) => {
  const res = await request(app).get('/api/v1/customers').set(auth(owner.token));
  return res.body.data.find((c: { _id: string }) => c._id === customerId);
};

describe('Payment/outstanding synchronization (single source of truth)', () => {
  it('customer outstanding reflects delivery dues even with a zero sales-ledger balance', async () => {
    const { owner, productId, customerId } = await setup(500);
    // Delivery total 5000, paid 2000 => outstanding 3000
    await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 2000, lines: [{ productId, quantity: 10 }] });

    const row = await customerRow(owner, customerId);
    expect(row.currentBalanceMinor).toBe(0);          // sales ledger is empty
    expect(row.deliveryOutstandingMinor).toBe(300000); // Rs 3000 from the delivery
    expect(row.totalOutstandingMinor).toBe(300000);    // unified outstanding

    // Payment-section view (delivery summary) shows the same numbers
    const sum = await request(app).get(`${D}/customer/${customerId}`).set(auth(owner.token));
    expect(sum.body.data.totalPurchasesMinor).toBe(500000);
    expect(sum.body.data.totalPaidMinor).toBe(200000);
    expect(sum.body.data.outstandingMinor).toBe(300000);
  });

  it('paying a delivery reduces the unified customer outstanding everywhere', async () => {
    const { owner, productId, customerId } = await setup(500);
    const del = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 2000, lines: [{ productId, quantity: 10 }] });
    const id = del.body.data.delivery._id;

    // Test 2 spec: pay 1000 -> paid 3000, outstanding 2000
    await request(app).post(`${D}/${id}/payments`).set(auth(owner.token)).send({ amount: 1000 });
    let row = await customerRow(owner, customerId);
    expect(row.totalOutstandingMinor).toBe(200000);

    // pay 1000 -> outstanding 1000
    await request(app).post(`${D}/${id}/payments`).set(auth(owner.token)).send({ amount: 1000 });
    row = await customerRow(owner, customerId);
    expect(row.totalOutstandingMinor).toBe(100000);

    // final 1000 -> outstanding 0, delivery PAID
    const final = await request(app).post(`${D}/${id}/payments`).set(auth(owner.token)).send({ amount: 1000 });
    expect(final.body.data.delivery.paymentStatus).toBe('PAID');
    row = await customerRow(owner, customerId);
    expect(row.totalOutstandingMinor).toBe(0);
  });

  it('aggregates multiple deliveries per customer correctly', async () => {
    const { owner, productId, customerId } = await setup(500);
    // Delivery 1: 5000 paid 2000 (out 3000); Delivery 2: 8000 paid 5000 (out 3000)
    await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 2000, lines: [{ productId, quantity: 10 }] });
    await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 5000, lines: [{ productId, quantity: 16 }] });

    const sum = await request(app).get(`${D}/customer/${customerId}`).set(auth(owner.token));
    expect(sum.body.data.totalPurchasesMinor).toBe(1300000); // Rs 13,000
    expect(sum.body.data.totalPaidMinor).toBe(700000);        // Rs 7,000
    expect(sum.body.data.outstandingMinor).toBe(600000);      // Rs 6,000

    const row = await customerRow(owner, customerId);
    expect(row.totalOutstandingMinor).toBe(600000);
  });
});
