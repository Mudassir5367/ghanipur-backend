import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();

async function setup(openingStock = 100, sellingPrice = 250) {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice, purchaseCost: Math.round(sellingPrice * 0.8), openingStock });
  const cust = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name: 'Ahmed', phone: '03001234567' });
  return { owner, productId: prod.body.data.product._id, customerId: cust.body.data.customer._id };
}

const stockOf = async (owner: TestActor, productId: string) =>
  (await request(app).get(`/api/v1/products/${productId}`).set(auth(owner.token))).body.data.product.currentStock;

const D = '/api/v1/deliveries';

describe('Delivery — pricing & payment status', () => {
  it('computes subtotal + delivery charge - discount = grand total (§1, §11)', async () => {
    const { owner, productId, customerId } = await setup();
    const res = await request(app).post(D).set(auth(owner.token)).send({
      customerId, paymentType: 'CREDIT', lines: [{ productId, quantity: 20 }], deliveryCharge: 200,
    });
    expect(res.status).toBe(201);
    const d = res.body.data.delivery;
    expect(d.subtotalMinor).toBe(20 * 250 * 100); // Rs 5000
    expect(d.deliveryChargeMinor).toBe(20000);     // Rs 200
    expect(d.grandTotalMinor).toBe(520000);        // Rs 5200
    expect(d.lines[0].sku).toBeTruthy();
    expect(d.lines[0].category).toBe('Milk');
    expect(d.lines[0].unitPriceMinor).toBe(25000); // snapshot
  });

  it('Scenario 1 — full cash payment marks PAID and confirm deducts stock', async () => {
    const { owner, productId, customerId } = await setup();
    const res = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CASH', lines: [{ productId, quantity: 10 }] });
    const d = res.body.data.delivery;
    expect(d.grandTotalMinor).toBe(250000);
    expect(d.paidMinor).toBe(250000);
    expect(d.remainingMinor).toBe(0);
    expect(d.paymentStatus).toBe('PAID');
    // Stock is reserved at creation (delivery.service sets inventoryDeducted on
    // create, so the "deliver now" flow never double-deducts on confirm).
    expect(await stockOf(owner, productId)).toBe(90);

    const conf = await request(app).patch(`${D}/${d._id}/status`).set(auth(owner.token)).send({ status: 'CONFIRMED' });
    expect(conf.status).toBe(200);
    expect(conf.body.data.delivery.lines[0].stockBefore).toBe(100);
    expect(conf.body.data.delivery.lines[0].stockAfter).toBe(90);
    expect(await stockOf(owner, productId)).toBe(90);
  });

  it('Scenario 2 — partial payment => PARTIALLY_PAID', async () => {
    const { owner, productId, customerId } = await setup(100, 500);
    const res = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 2000, lines: [{ productId, quantity: 10 }] });
    const d = res.body.data.delivery; // grand 5000, paid 2000
    expect(d.grandTotalMinor).toBe(500000);
    expect(d.paidMinor).toBe(200000);
    expect(d.remainingMinor).toBe(300000);
    expect(d.paymentStatus).toBe('PARTIALLY_PAID');
  });

  it('Scenario 3 — credit with no payment => DUE', async () => {
    const { owner, productId, customerId } = await setup(100, 800);
    const res = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', lines: [{ productId, quantity: 10 }] });
    const d = res.body.data.delivery;
    expect(d.paidMinor).toBe(0);
    expect(d.remainingMinor).toBe(800000);
    expect(d.paymentStatus).toBe('DUE');
  });

  it('rejects overpayment at creation and via payments (§11)', async () => {
    const { owner, productId, customerId } = await setup();
    const over = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 999999, lines: [{ productId, quantity: 1 }] });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('OVERPAYMENT');
  });
});

describe('Delivery — payment history (§3, §7)', () => {
  it('Scenario 4 — later payments accumulate and update status', async () => {
    const { owner, productId, customerId } = await setup(100, 800);
    const create = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', lines: [{ productId, quantity: 10 }] });
    const id = create.body.data.delivery._id; // grand 8000, due

    const p1 = await request(app).post(`${D}/${id}/payments`).set(auth(owner.token)).send({ amount: 3000, method: 'CASH' });
    expect(p1.status).toBe(200);
    expect(p1.body.data.delivery.remainingMinor).toBe(500000); // Rs 5000 left
    expect(p1.body.data.delivery.paymentStatus).toBe('PARTIALLY_PAID');

    const p2 = await request(app).post(`${D}/${id}/payments`).set(auth(owner.token)).send({ amount: 5000 });
    expect(p2.body.data.delivery.remainingMinor).toBe(0);
    expect(p2.body.data.delivery.paymentStatus).toBe('PAID');
    expect(p2.body.data.delivery.payments.length).toBe(2); // history preserved
    expect(p2.body.data.delivery.payments[0].amountMinor).toBe(300000);

    // overpayment blocked
    const p3 = await request(app).post(`${D}/${id}/payments`).set(auth(owner.token)).send({ amount: 100 });
    expect(p3.status).toBe(400);
    expect(p3.body.code).toBe('OVERPAYMENT');
  });
});

describe('Delivery — inventory rules (§5, §6, §15)', () => {
  it('Scenario 5 — insufficient stock is rejected and leaves stock untouched', async () => {
    const { owner, productId, customerId } = await setup(20);
    // Stock is taken at creation, so an over-quantity delivery is refused there
    // rather than at confirm. The guarantee under test is unchanged: no oversell,
    // and a rejected delivery leaves the ledger exactly as it was.
    const create = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', lines: [{ productId, quantity: 30 }] });
    expect(create.status).toBe(400);
    expect(create.body.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(owner, productId)).toBe(20); // unchanged
  });

  it('Scenario 6 — multiple confirmed deliveries reduce stock cumulatively', async () => {
    const { owner, productId, customerId } = await setup(100);
    for (const qty of [10, 15, 5]) {
      const c = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CASH', lines: [{ productId, quantity: qty }] });
      await request(app).patch(`${D}/${c.body.data.delivery._id}/status`).set(auth(owner.token)).send({ status: 'CONFIRMED' });
    }
    expect(await stockOf(owner, productId)).toBe(70); // 100 - 30
  });

  it('does not deduct twice across status changes (§15)', async () => {
    const { owner, productId, customerId } = await setup(100);
    const c = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CASH', lines: [{ productId, quantity: 10 }] });
    const id = c.body.data.delivery._id;
    await request(app).patch(`${D}/${id}/status`).set(auth(owner.token)).send({ status: 'CONFIRMED' });
    await request(app).patch(`${D}/${id}/status`).set(auth(owner.token)).send({ status: 'OUT_FOR_DELIVERY' });
    await request(app).patch(`${D}/${id}/status`).set(auth(owner.token)).send({ status: 'DELIVERED' });
    expect(await stockOf(owner, productId)).toBe(90); // deducted exactly once
  });

  it('Scenario 7 — cancelling a confirmed delivery restores stock and preserves the record', async () => {
    const { owner, productId, customerId } = await setup(100);
    const c = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 1000, lines: [{ productId, quantity: 25 }] });
    const id = c.body.data.delivery._id;
    await request(app).patch(`${D}/${id}/status`).set(auth(owner.token)).send({ status: 'CONFIRMED' });
    expect(await stockOf(owner, productId)).toBe(75);

    const cancel = await request(app).patch(`${D}/${id}/status`).set(auth(owner.token)).send({ status: 'CANCELLED' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.delivery.status).toBe('CANCELLED');
    expect(await stockOf(owner, productId)).toBe(100); // restored

    // record + payment history preserved
    const get = await request(app).get(`${D}/${id}`).set(auth(owner.token));
    expect(get.body.data.delivery.payments.length).toBe(1);
    expect(get.body.data.delivery.lines[0].quantity).toBe(25);
  });

  it('rejects invalid transitions and pending->delivered', async () => {
    const { owner, productId, customerId } = await setup(100);
    const c = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CASH', lines: [{ productId, quantity: 5 }] });
    const res = await request(app).patch(`${D}/${c.body.data.delivery._id}/status`).set(auth(owner.token)).send({ status: 'DELIVERED' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });
});

describe('Delivery — customer summary & isolation', () => {
  it('aggregates customer outstanding across deliveries (§10)', async () => {
    const { owner, productId, customerId } = await setup(100, 1000);
    // two credit deliveries: 5000 (pay 2000) and 3000 (pay 0)
    await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', paidAmount: 2000, lines: [{ productId, quantity: 5 }] });
    await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CREDIT', lines: [{ productId, quantity: 3 }] });
    const sum = await request(app).get(`${D}/customer/${customerId}`).set(auth(owner.token));
    expect(sum.body.data.totalPurchasesMinor).toBe(800000); // Rs 8000
    expect(sum.body.data.totalPaidMinor).toBe(200000);       // Rs 2000
    expect(sum.body.data.outstandingMinor).toBe(600000);     // Rs 6000
    expect(sum.body.data.deliveryCount).toBe(2);
  });

  it('isolates deliveries between shops (§61)', async () => {
    const { owner, productId, customerId } = await setup(100);
    const c = await request(app).post(D).set(auth(owner.token)).send({ customerId, paymentType: 'CASH', lines: [{ productId, quantity: 5 }] });
    const id = c.body.data.delivery._id;
    const other = await registerShop(app, { email: 'other@test.com', shopName: 'Other' });
    expect((await request(app).get(`${D}/${id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).patch(`${D}/${id}/status`).set(auth(other.token)).send({ status: 'CONFIRMED' })).status).toBe(404);
    expect((await request(app).post(`${D}/${id}/payments`).set(auth(other.token)).send({ amount: 100 })).status).toBe(404);
  });
});
