import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, createSuperAdmin, auth } from './helpers.js';
import { AuditLog } from '../src/models/auditLog.model.js';

const app = createApp();

/**
 * §61 — MANDATORY tenant-isolation test. Shop A must never reach Shop B's data.
 * This suite grows with every phase that adds a shop-owned resource
 * (products, sales, customers, payments, inventory, deliveries, reports).
 */
describe('Tenant isolation (§61)', () => {
  async function twoShopsWithStaff() {
    const shopA = await registerShop(app, { email: 'a-owner@test.com', shopName: 'Shop A' });
    const shopB = await registerShop(app, { email: 'b-owner@test.com', shopName: 'Shop B' });
    const sA = await request(app).post('/api/v1/staff').set(auth(shopA.token)).send({ name: 'A worker', email: 'a-staff@test.com', password: 'password123' });
    const sB = await request(app).post('/api/v1/staff').set(auth(shopB.token)).send({ name: 'B worker', email: 'b-staff@test.com', password: 'password123' });
    return { shopA, shopB, staffAId: sA.body.data.staff.id, staffBId: sB.body.data.staff.id };
  }

  it('Shop A only ever sees its own shop via /shops/me', async () => {
    const { shopA } = await twoShopsWithStaff();
    const res = await request(app).get('/api/v1/shops/me').set(auth(shopA.token));
    expect(res.body.data.shop._id).toBe(shopA.shopId);
  });

  it('Shop A cannot widen scope with a forged x-shop-id header', async () => {
    const { shopA, shopB } = await twoShopsWithStaff();
    const res = await request(app)
      .get('/api/v1/shops/me')
      .set(auth(shopA.token))
      .set('x-shop-id', shopB.shopId!); // attacker tries to target Shop B
    expect(res.status).toBe(200);
    expect(res.body.data.shop._id).toBe(shopA.shopId); // header ignored for shop-scoped roles
  });

  it('Shop A staff listing excludes Shop B users', async () => {
    const { shopA } = await twoShopsWithStaff();
    const res = await request(app).get('/api/v1/staff').set(auth(shopA.token));
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain('a-owner@test.com');
    expect(emails).toContain('a-staff@test.com');
    expect(emails).not.toContain('b-owner@test.com');
    expect(emails).not.toContain('b-staff@test.com');
  });

  it('Shop A cannot read, update or delete Shop B staff (404, not 403 leak)', async () => {
    const { shopA, staffBId } = await twoShopsWithStaff();
    const update = await request(app).patch(`/api/v1/staff/${staffBId}`).set(auth(shopA.token)).send({ name: 'hijacked' });
    expect(update.status).toBe(404);
    const del = await request(app).delete(`/api/v1/staff/${staffBId}`).set(auth(shopA.token));
    expect(del.status).toBe(404);
  });

  it('Settings changes in Shop A do not affect Shop B', async () => {
    const { shopA, shopB } = await twoShopsWithStaff();
    await request(app).patch('/api/v1/shops/me/settings').set(auth(shopA.token)).send({ paymentMethods: ['CASH'] });
    const bSettings = await request(app).get('/api/v1/shops/me/settings').set(auth(shopB.token));
    expect(bSettings.body.data.settings.paymentMethods.length).toBeGreaterThan(1);
  });

  it('Super admin CAN target a specific shop via x-shop-id, and it is audited', async () => {
    const { shopB } = await twoShopsWithStaff();
    const su = await createSuperAdmin(app);
    const res = await request(app).get('/api/v1/shops/me').set(auth(su.token)).set('x-shop-id', shopB.shopId!);
    expect(res.status).toBe(200);
    expect(res.body.data.shop._id).toBe(shopB.shopId);

    const audit = await AuditLog.findOne({ action: 'IMPERSONATE_SHOP', shopId: shopB.shopId });
    expect(audit).not.toBeNull();
  });

  it('Super admin without x-shop-id is refused shop-scoped access', async () => {
    await twoShopsWithStaff();
    const su = await createSuperAdmin(app);
    const res = await request(app).get('/api/v1/shops/me').set(auth(su.token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SHOP_REQUIRED');
  });

  it('Categories and products are isolated between shops (§61)', async () => {
    const { shopA, shopB } = await twoShopsWithStaff();

    // Shop A creates a category + product
    const unitsA = await request(app).get('/api/v1/units').set(auth(shopA.token));
    const unitId = unitsA.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
    const catA = await request(app).post('/api/v1/categories').set(auth(shopA.token)).send({ name: 'A Milk' });
    const catAId = catA.body.data.category._id;
    const prodA = await request(app).post('/api/v1/products').set(auth(shopA.token)).send({ name: 'A Product', categoryId: catAId, unitId, sellingPrice: 200, openingStock: 20 });
    const prodAId = prodA.body.data.product._id;

    // Shop B sees none of Shop A's catalog
    const bCats = await request(app).get('/api/v1/categories').set(auth(shopB.token));
    expect(bCats.body.data.length).toBe(0);
    const bProducts = await request(app).get('/api/v1/products').set(auth(shopB.token));
    expect(bProducts.body.data.length).toBe(0);

    // Shop B cannot read or mutate Shop A's product
    expect((await request(app).get(`/api/v1/products/${prodAId}`).set(auth(shopB.token))).status).toBe(404);
    expect((await request(app).patch(`/api/v1/products/${prodAId}`).set(auth(shopB.token)).send({ name: 'hijack' })).status).toBe(404);
    // Shop B cannot inject inventory movements into Shop A's product
    const inject = await request(app).post(`/api/v1/products/${prodAId}/inventory`).set(auth(shopB.token)).send({ type: 'WASTAGE', quantity: 5 });
    expect(inject.status).toBe(404);
    // Shop B cannot read Shop A's category
    expect((await request(app).get(`/api/v1/categories/${catAId}`).set(auth(shopB.token))).status).toBe(404);
  });

  it('Customers, sales and payments are isolated between shops (§61)', async () => {
    const { shopA, shopB } = await twoShopsWithStaff();

    // Shop A: product + customer + credit sale
    const unitsA = await request(app).get('/api/v1/units').set(auth(shopA.token));
    const unitId = unitsA.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
    const catA = await request(app).post('/api/v1/categories').set(auth(shopA.token)).send({ name: 'A Milk' });
    const prodA = await request(app).post('/api/v1/products').set(auth(shopA.token)).send({ name: 'A Milk', categoryId: catA.body.data.category._id, unitId, sellingPrice: 200, openingStock: 50 });
    const custA = await request(app).post('/api/v1/customers').set(auth(shopA.token)).send({ name: 'A Customer' });
    const custAId = custA.body.data.customer._id;
    const saleA = await request(app).post('/api/v1/sales').set(auth(shopA.token)).send({ type: 'CREDIT', customerId: custAId, items: [{ productId: prodA.body.data.product._id, quantity: 5 }] });
    const saleAId = saleA.body.data.sale._id;

    // Shop B sees none of it
    expect((await request(app).get('/api/v1/customers').set(auth(shopB.token))).body.data.length).toBe(0);
    expect((await request(app).get('/api/v1/sales').set(auth(shopB.token))).body.data.length).toBe(0);

    // Shop B cannot read Shop A's customer, ledger, or sale
    expect((await request(app).get(`/api/v1/customers/${custAId}`).set(auth(shopB.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/customers/${custAId}/ledger`).set(auth(shopB.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/sales/${saleAId}`).set(auth(shopB.token))).status).toBe(404);

    // Shop B cannot reverse Shop A's sale or post a payment to Shop A's customer
    expect((await request(app).post(`/api/v1/sales/${saleAId}/reverse`).set(auth(shopB.token))).status).toBe(404);
    const crossPay = await request(app).post('/api/v1/payments').set(auth(shopB.token)).send({ customerId: custAId, amount: 100 });
    expect(crossPay.status).toBe(400); // customer not found in Shop B's scope
  });
});
