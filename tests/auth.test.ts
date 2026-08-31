import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import * as userRepo from '../src/repositories/dynamo/userRepository.js';

const app = createApp();

const validUser = {
  name: 'Ali Raza',
  email: 'ali@example.com',
  password: 'password123',
  phone: '03001234567',
};

describe('Auth — public user signup', () => {
  it('registers a NORMAL USER (no shop, no admin powers)', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(validUser);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.role).toBe('USER');
    expect(res.body.data.user.shopId).toBeNull();
    expect(res.body.data.user.permissions).toHaveLength(0); // no shop permissions

    // Password never stored plainly or returned.
    const user = await userRepo.findByEmail(validUser.email);
    expect(user?.passwordHash).not.toBe(validUser.password);
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('rejects duplicate email', async () => {
    await request(app).post('/api/v1/auth/register').send(validUser);
    const res = await request(app).post('/api/v1/auth/register').send(validUser);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
  });

  it('logs in and returns a working access token for /me', async () => {
    await request(app).post('/api/v1/auth/register').send(validUser);
    const login = await request(app).post('/api/v1/auth/login').send({ email: validUser.email, password: validUser.password });
    expect(login.status).toBe(200);
    const token = login.body.data.accessToken as string;

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(validUser.email);
    expect(me.body.data.user.role).toBe('USER');
  });

  it('rejects bad credentials', async () => {
    await request(app).post('/api/v1/auth/register').send(validUser);
    const res = await request(app).post('/api/v1/auth/login').send({ email: validUser.email, password: 'wrongpass' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects /me without a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('refreshes the session via cookie and revokes on logout', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send(validUser);
    const cookie = reg.headers['set-cookie'];
    expect(cookie).toBeTruthy();

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toBeTruthy();

    const token = refreshed.body.data.accessToken as string;
    const newCookie = refreshed.headers['set-cookie'] ?? cookie;
    await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`);

    const afterLogout = await request(app).post('/api/v1/auth/refresh').set('Cookie', newCookie);
    expect(afterLogout.status).toBe(401);
  });

  it('validates registration input', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ email: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
