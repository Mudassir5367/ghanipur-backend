import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, createSuperAdmin, auth } from './helpers.js';

const app = createApp();

async function setupActivity() {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Buffalo Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice: 250, purchaseCost: 200, openingStock: 100 });
  const productId = prod.body.data.product._id;
  const cust = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name: 'Ali Hotel' });
  const customerId = cust.body.data.customer._id;

  await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity: 15 }] });
  await request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 30 }] });
  await request(app).post('/api/v1/payments').set(auth(owner.token)).send({ customerId, amount: 3000 });
  await request(app).post(`/api/v1/products/${productId}/inventory`).set(auth(owner.token)).send({ type: 'WASTAGE', quantity: 5 });
  return { owner, productId };
}

describe('Reports (§18, §28)', () => {
  it('dashboard aggregates cash/credit sales, payments and outstanding', async () => {
    const { owner } = await setupActivity();
    const res = await request(app).get('/api/v1/reports/dashboard').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.sales.cashMinor).toBe(15 * 250 * 100);   // Rs 3,750
    expect(res.body.data.sales.creditMinor).toBe(30 * 250 * 100);  // Rs 7,500
    expect(res.body.data.sales.totalMinor).toBe(45 * 250 * 100);
    // All money received = cash sale (Rs 3,750) + credit collection (Rs 3,000).
    expect(res.body.data.paymentsReceivedMinor).toBe(375000 + 300000); // Rs 6,750
    expect(res.body.data.outstandingMinor).toBe(750000 - 300000);  // Rs 4,500 left
    expect(res.body.data.qtySold).toBe(45);
  });

  it('daily-milk derives opening/in/sold/wastage/closing from the ledger (§10)', async () => {
    const { owner } = await setupActivity();
    const res = await request(app).get('/api/v1/reports/daily-milk').set(auth(owner.token));
    expect(res.status).toBe(200);
    const row = res.body.data.rows[0];
    expect(row.stockIn).toBe(100);
    expect(row.sold).toBe(45);
    expect(row.wastage).toBe(5);
    expect(row.closing).toBe(50); // 100 - 45 - 5
  });

  it('daily report includes wastage and product breakdown', async () => {
    const { owner } = await setupActivity();
    const res = await request(app).get('/api/v1/reports/daily').set(auth(owner.token));
    expect(res.body.data.wastageQty).toBe(5);
    expect(res.body.data.products[0].qty).toBe(45);
    expect(res.body.data.products[0].revenueMinor).toBe(45 * 250 * 100);
  });

  it('platform overview counts shops by status (super admin)', async () => {
    await registerShop(app, { email: 'p1@test.com', shopName: 'P1' });
    await registerShop(app, { email: 'p2@test.com', shopName: 'P2' });
    const su = await createSuperAdmin(app);
    const res = await request(app).get('/api/v1/reports/platform/overview').set(auth(su.token));
    expect(res.status).toBe(200);
    expect(res.body.data.totalShops).toBe(2);
    expect(res.body.data.pendingShops).toBe(2);
    expect(res.body.data.activeShops).toBe(0);
  });

  it('denies report access without REPORT_VIEW / shop context', async () => {
    const su = await createSuperAdmin(app);
    // super admin without x-shop-id cannot read a shop dashboard
    const res = await request(app).get('/api/v1/reports/dashboard').set(auth(su.token));
    expect(res.status).toBe(400);
  });
});
