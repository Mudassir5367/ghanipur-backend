import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth } from './helpers.js';

const app = createApp();

describe('Expenses (§20)', () => {
  it('records and lists expenses, converting rupees to paisa', async () => {
    const owner = await registerShop(app);
    const create = await request(app).post('/api/v1/expenses').set(auth(owner.token)).send({ category: 'Rent', amount: 50000, description: 'Shop rent' });
    expect(create.status).toBe(201);
    expect(create.body.data.expense.amountMinor).toBe(5000000);

    const list = await request(app).get('/api/v1/expenses').set(auth(owner.token));
    expect(list.body.data.length).toBe(1);
    expect(list.body.data[0].category).toBe('Rent');
  });

  it('isolates expenses between shops (§61)', async () => {
    const a = await registerShop(app, { email: 'ea@test.com', shopName: 'EA' });
    const b = await registerShop(app, { email: 'eb@test.com', shopName: 'EB' });
    await request(app).post('/api/v1/expenses').set(auth(a.token)).send({ category: 'Electricity', amount: 10000 });
    const bList = await request(app).get('/api/v1/expenses').set(auth(b.token));
    expect(bList.body.data.length).toBe(0);
  });
});
