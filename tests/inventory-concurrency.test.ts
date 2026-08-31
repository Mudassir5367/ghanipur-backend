import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth } from './helpers.js';
import { recomputeStock } from '../src/services/inventory.service.js';

const app = createApp();

/**
 * §36 — concurrency / data consistency. Fire many simultaneous outflows against
 * limited stock and assert the atomic guard never lets stock go negative and the
 * cached balance always matches the ledger.
 */
describe('Inventory concurrency (§36)', () => {
  it('never oversells under concurrent deductions', async () => {
    const owner = await registerShop(app);
    const unitsRes = await request(app).get('/api/v1/units').set(auth(owner.token));
    const unitId = unitsRes.body.data.find((u: { symbol: string }) => u.symbol === 'L')._id;
    const catRes = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
    const categoryId = catRes.body.data.category._id;
    const prodRes = await request(app)
      .post('/api/v1/products')
      .set(auth(owner.token))
      .send({ name: 'Milk', categoryId, unitId, sellingPrice: 250, purchaseCost: 200, openingStock: 10 });
    const productId = prodRes.body.data.product._id;

    // 25 concurrent wastages of 1L against 10L of stock.
    const attempts = 25;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app).post(`/api/v1/products/${productId}/inventory`).set(auth(owner.token)).send({ type: 'WASTAGE', quantity: 1 }),
      ),
    );

    const ok = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 400).length;
    expect(ok).toBe(10); // exactly the available stock
    expect(rejected).toBe(attempts - 10);

    const final = await request(app).get(`/api/v1/products/${productId}`).set(auth(owner.token));
    expect(final.body.data.product.currentStock).toBe(0); // never negative

    // Cached stock equals the ledger sum.
    const ledgerTotal = await recomputeStock({ shopId: owner.shopId!, impersonated: false }, productId);
    expect(ledgerTotal).toBe(0);
  });
});
