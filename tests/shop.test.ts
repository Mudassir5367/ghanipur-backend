import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, createSuperAdmin, auth } from './helpers.js';
import { ShopStatus } from '../src/repositories/dynamo/shopRepository.js';
import * as userRepo from '../src/repositories/dynamo/userRepository.js';

const app = createApp();

describe('Shop — own shop management', () => {
  it('returns the owner\'s own shop and defaults settings', async () => {
    const owner = await registerShop(app);
    const res = await request(app).get('/api/v1/shops/me').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.shop._id).toBe(owner.shopId);
    expect(res.body.data.shop.status).toBe(ShopStatus.PENDING);

    const settings = await request(app).get('/api/v1/shops/me/settings').set(auth(owner.token));
    expect(settings.status).toBe(200);
    expect(settings.body.data.settings.paymentMethods).toContain('EASYPAISA');
    expect(settings.body.data.settings.customerTypes).toContain('HOTEL');
  });

  it('updates own shop profile', async () => {
    const owner = await registerShop(app);
    const res = await request(app)
      .patch('/api/v1/shops/me')
      .set(auth(owner.token))
      .send({ description: 'Fresh buffalo milk daily', phone: '03001234567', address: { city: 'Lahore' } });
    expect(res.status).toBe(200);
    expect(res.body.data.shop.description).toBe('Fresh buffalo milk daily');
    expect(res.body.data.shop.address.city).toBe('Lahore');
  });

  it('updates configurable settings (payment methods / customer types)', async () => {
    const owner = await registerShop(app);
    const res = await request(app)
      .patch('/api/v1/shops/me/settings')
      .set(auth(owner.token))
      .send({ paymentMethods: ['CASH', 'EASYPAISA'], customerTypes: ['HOTEL', 'HOUSEHOLD'] });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.paymentMethods).toEqual(['CASH', 'EASYPAISA']);
  });
});

describe('Shop — super admin lifecycle', () => {
  it('lists all shops and filters by status', async () => {
    await registerShop(app, { email: 'a@test.com', shopName: 'Alpha' });
    await registerShop(app, { email: 'b@test.com', shopName: 'Beta' });
    const su = await createSuperAdmin(app);

    const all = await request(app).get('/api/v1/shops').set(auth(su.token));
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBe(2);
    expect(all.body.meta.total).toBe(2);

    const pending = await request(app).get('/api/v1/shops?status=PENDING').set(auth(su.token));
    expect(pending.body.data.length).toBe(2);
  });

  it('approves, suspends and reactivates a shop', async () => {
    const owner = await registerShop(app);
    const su = await createSuperAdmin(app);

    const approve = await request(app)
      .patch(`/api/v1/shops/${owner.shopId}/status`)
      .set(auth(su.token))
      .send({ status: ShopStatus.ACTIVE });
    expect(approve.status).toBe(200);
    expect(approve.body.data.shop.status).toBe(ShopStatus.ACTIVE);

    // Now visible on the public storefront
    const pub = await request(app).get('/api/v1/shops/public');
    expect(pub.body.data.length).toBe(1);

    const suspend = await request(app)
      .patch(`/api/v1/shops/${owner.shopId}/status`)
      .set(auth(su.token))
      .send({ status: ShopStatus.SUSPENDED });
    expect(suspend.body.data.shop.status).toBe(ShopStatus.SUSPENDED);

    // Suspended shops disappear from public listing
    const pub2 = await request(app).get('/api/v1/shops/public');
    expect(pub2.body.data.length).toBe(0);
  });

  it('logs an already logged-in admin out on their next call once the shop is suspended', async () => {
    const owner = await registerShop(app, { status: ShopStatus.ACTIVE });
    const su = await createSuperAdmin(app);
    expect((await request(app).get('/api/v1/auth/me').set(auth(owner.token))).status).toBe(200);

    await request(app).patch(`/api/v1/shops/${owner.shopId}/status`).set(auth(su.token)).send({ status: ShopStatus.SUSPENDED });

    // Any call with the still-unexpired access token is rejected — shop-scoped or not.
    for (const path of ['/api/v1/auth/me', '/api/v1/products', '/api/v1/reports/dashboard']) {
      const res = await request(app).get(path).set(auth(owner.token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SHOP_SUSPENDED');
    }
    // The session is ended server-side (no silent refresh back in).
    expect((await userRepo.findById(owner.userId))?.refreshTokenHash).toBeFalsy();

    // Super admin still manages the suspended shop.
    const listed = await request(app).get(`/api/v1/shops/${owner.shopId}`).set(auth(su.token));
    expect(listed.status).toBe(200);

    // Reactivated: the admin logs in again and works normally.
    await request(app).patch(`/api/v1/shops/${owner.shopId}/status`).set(auth(su.token)).send({ status: ShopStatus.ACTIVE });
    const login = await request(app).post('/api/v1/auth/login').send({ email: owner.email, password: 'password123' });
    expect(login.status).toBe(200);
    expect((await request(app).get('/api/v1/products').set(auth(login.body.data.accessToken))).status).toBe(200);
  });

  it('creates a shop with a new owner (pre-approved)', async () => {
    const su = await createSuperAdmin(app);
    const res = await request(app)
      .post('/api/v1/shops')
      .set(auth(su.token))
      .send({ shopName: 'Created Dairy', ownerName: 'New Owner', ownerEmail: 'newowner@test.com', ownerPassword: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.data.shop.status).toBe(ShopStatus.ACTIVE);

    // The new owner can log in and see their shop
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'newowner@test.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.data.user.shopId).toBe(res.body.data.shop._id);
  });

  it('forbids a shop admin from super-admin routes', async () => {
    const owner = await registerShop(app);
    const res = await request(app).get('/api/v1/shops').set(auth(owner.token));
    expect(res.status).toBe(403);
  });
});
