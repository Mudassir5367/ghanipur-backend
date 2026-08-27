import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth } from './helpers.js';
import { recomputeCustomerBalance } from '../src/services/ledger.service.js';

const app = createApp();

/**
 * §36/§37 — concurrent credit sales against one customer must produce an exact
 * balance with no lost updates, and the cached balance must equal the ledger.
 */
describe('Ledger concurrency (§37)', () => {
  it('keeps the customer balance exact under concurrent credit sales', async () => {
    const owner = await registerShop(app);
    const units = await request(app).get('/api/v1/units').set(auth(owner.token));
    const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
    const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
    const prod = await request(app).post('/api/v1/products').set(auth(owner.token)).send({ name: 'Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice: 250, openingStock: 100 });
    const productId = prod.body.data.product._id;
    const cust = await request(app).post('/api/v1/customers').set(auth(owner.token)).send({ name: 'Hotel' });
    const customerId = cust.body.data.customer._id;

    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CREDIT', customerId, items: [{ productId, quantity: 1 }] }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const customer = await request(app).get(`/api/v1/customers/${customerId}`).set(auth(owner.token));
    expect(customer.body.data.customer.currentBalanceMinor).toBe(n * 25000); // exact, no lost updates

    const rebuilt = await recomputeCustomerBalance({ shopId: owner.shopId!, impersonated: false }, customerId);
    expect(rebuilt).toBe(n * 25000); // cache == ledger
  });
});
