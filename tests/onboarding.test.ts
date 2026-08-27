import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createSuperAdmin, auth } from './helpers.js';

const app = createApp();
const SETUP_KEY = 'test-setup-key-123456';

describe('Super admin provisioning (§1)', () => {
  it('requires the setup key (no public signup)', async () => {
    const noKey = await request(app).post('/api/v1/super-admin/register').send({ name: 'Root', email: 'root1@test.com', password: 'password123' });
    expect(noKey.status).toBe(403);
    expect(noKey.body.code).toBe('SETUP_FORBIDDEN');

    const wrongKey = await request(app).post('/api/v1/super-admin/register').set('x-setup-key', 'nope').send({ name: 'Root', email: 'root1@test.com', password: 'password123' });
    expect(wrongKey.status).toBe(403);
  });

  it('creates a super admin with the correct setup key, who can then log in', async () => {
    const res = await request(app).post('/api/v1/super-admin/register').set('x-setup-key', SETUP_KEY).send({ name: 'Root', email: 'root@test.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('SUPER_ADMIN');

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'root@test.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe('SUPER_ADMIN');
  });
});

describe('Admin provisioning (§1)', () => {
  it('cannot be called publicly or by a normal user', async () => {
    // No setup key and no super-admin token -> forbidden (403) by the provisioning gate.
    const anon = await request(app).post('/api/v1/admin/register').send({ name: 'A', email: 'a@test.com', password: 'password123' });
    expect(anon.status).toBe(403);

    // normal user
    const reg = await request(app).post('/api/v1/auth/register').send({ name: 'User', email: 'u@test.com', password: 'password123' });
    const userToken = reg.body.data.accessToken;
    const asUser = await request(app).post('/api/v1/admin/register').set(auth(userToken)).send({ name: 'A', email: 'a2@test.com', password: 'password123' });
    expect(asUser.status).toBe(403);
  });

  it('lets a super admin create a shop admin (account only — no shop)', async () => {
    const su = await createSuperAdmin(app);

    // Admin is created WITHOUT a shop; they set one up themselves after logging in.
    const admin = await request(app).post('/api/v1/admin/register').set(auth(su.token)).send({ name: 'Owner', email: 'owner@test.com', password: 'password123' });
    expect(admin.status).toBe(201);
    expect(admin.body.data.user.role).toBe('SHOP_ADMIN');
    expect(admin.body.data.user.shopId).toBeNull();
  });
});

describe('Shop admin self-onboarding (§2)', () => {
  it('a fresh admin creates their own shop and gets a refreshed token', async () => {
    const su = await createSuperAdmin(app);
    await request(app).post('/api/v1/admin/register').set(auth(su.token)).send({ name: 'Owner', email: 'self@test.com', password: 'password123' });
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'self@test.com', password: 'password123' });
    const token = login.body.data.accessToken;

    // Before a shop exists, tenant-scoped calls are refused
    expect((await request(app).get('/api/v1/shops/me').set(auth(token))).status).toBe(403);

    const created = await request(app).post('/api/v1/shops/mine').set(auth(token)).send({ shopName: 'My Dairy' });
    expect(created.status).toBe(201);
    expect(created.body.data.accessToken).toBeTruthy(); // re-issued token carries the new shopId
    expect(created.body.data.user.shopId).toBeTruthy();

    // The new token can now access the shop, which has default categories
    const newToken = created.body.data.accessToken;
    const me = await request(app).get('/api/v1/shops/me').set(auth(newToken));
    expect(me.status).toBe(200);
    const cats = await request(app).get('/api/v1/categories').set(auth(newToken));
    expect(cats.body.data.length).toBeGreaterThanOrEqual(10);

    // Cannot create a second shop
    const again = await request(app).post('/api/v1/shops/mine').set(auth(newToken)).send({ shopName: 'Another' });
    expect(again.status).toBe(409);
  });
});
