import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth } from './helpers.js';

const app = createApp();

async function addStaff(token: string, email: string) {
  return request(app)
    .post('/api/v1/staff')
    .set(auth(token))
    .send({ name: 'Worker', email, password: 'password123' });
}

describe('Staff management', () => {
  it('creates staff and the staff can log in with SHOP_STAFF permissions', async () => {
    const owner = await registerShop(app);
    const create = await addStaff(owner.token, 'worker1@test.com');
    expect(create.status).toBe(201);
    expect(create.body.data.staff.role).toBe('SHOP_STAFF');

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'worker1@test.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.data.user.shopId).toBe(owner.shopId);
    // Staff can create sales but not reverse them
    expect(login.body.data.user.permissions).toContain('SALE_CREATE');
    expect(login.body.data.user.permissions).not.toContain('SALE_REVERSE');
  });

  it('lists only the shop\'s own users', async () => {
    const owner = await registerShop(app);
    await addStaff(owner.token, 'worker2@test.com');
    const res = await request(app).get('/api/v1/staff').set(auth(owner.token));
    expect(res.status).toBe(200);
    // owner + 1 staff
    expect(res.body.data.length).toBe(2);
  });

  it('deactivates staff and revokes their access', async () => {
    const owner = await registerShop(app);
    const create = await addStaff(owner.token, 'worker3@test.com');
    const staffId = create.body.data.staff.id;

    const del = await request(app).delete(`/api/v1/staff/${staffId}`).set(auth(owner.token));
    expect(del.status).toBe(200);
    expect(del.body.data.staff.isActive).toBe(false);

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'worker3@test.com', password: 'password123' });
    expect(login.status).toBe(403); // account disabled
  });

  it('protects the shop owner from deactivation', async () => {
    const owner = await registerShop(app);
    const res = await request(app).patch(`/api/v1/staff/${owner.userId}`).set(auth(owner.token)).send({ isActive: false });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OWNER_PROTECTED');
  });

  it('rejects a staff member (no USER_MANAGE) from managing staff', async () => {
    const owner = await registerShop(app);
    await addStaff(owner.token, 'worker4@test.com');
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'worker4@test.com', password: 'password123' });
    const staffToken = login.body.data.accessToken;

    const res = await request(app).post('/api/v1/staff').set(auth(staffToken)).send({ name: 'X', email: 'x@test.com', password: 'password123' });
    expect(res.status).toBe(403);
  });
});
