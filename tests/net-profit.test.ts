import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerShop, auth, type TestActor } from './helpers.js';

const app = createApp();
const TZ = 'Asia/Karachi'; // the shop default
const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = localDay(new Date());
const yesterday = localDay(new Date(Date.now() - 24 * 3600 * 1000));
const noonOf = (day: string) => new Date(`${day}T12:00:00+05:00`).toISOString();

async function setup() {
  const owner = await registerShop(app);
  const units = await request(app).get('/api/v1/units').set(auth(owner.token));
  const unitId = units.body.data.find((u: { symbol: string }) => u.symbol === 'kg')._id;
  const cat = await request(app).post('/api/v1/categories').set(auth(owner.token)).send({ name: 'Milk' });
  const prod = await request(app).post('/api/v1/products').set(auth(owner.token))
    .send({ name: 'Milk', categoryId: cat.body.data.category._id, unitId, sellingPrice: 250, purchaseCost: 200, openingStock: 500 });
  return { owner, productId: prod.body.data.product._id as string };
}

const addExpense = (owner: TestActor, body: Record<string, unknown>) =>
  request(app).post('/api/v1/expenses').set(auth(owner.token)).send(body);
const dashboard = async (owner: TestActor) =>
  (await request(app).get('/api/v1/reports/dashboard').set(auth(owner.token))).body.data;
const sell = (owner: TestActor, productId: string, quantity: number) =>
  request(app).post('/api/v1/sales').set(auth(owner.token)).send({ type: 'CASH', items: [{ productId, quantity }] });

describe('Expenditure', () => {
  it('records category, amount, date and description; edits and deletes', async () => {
    const { owner } = await setup();
    const created = await addExpense(owner, { category: 'Rent', amount: 5000, description: 'Shop rent', incurredAt: noonOf(today) });
    expect(created.status).toBe(201);
    const id = created.body.data.expense._id;

    const edited = await request(app).patch(`/api/v1/expenses/${id}`).set(auth(owner.token)).send({ category: 'Electricity Bill', amount: 3200, description: 'September' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.expense).toMatchObject({ category: 'Electricity Bill', amountMinor: 320000, description: 'September' });

    // Moving it to yesterday takes it off today's list and onto yesterday's.
    const moved = await request(app).patch(`/api/v1/expenses/${id}`).set(auth(owner.token)).send({ incurredAt: noonOf(yesterday) });
    expect(moved.status).toBe(200);
    const list = async (day: string) =>
      (await request(app).get('/api/v1/expenses').query({ from: new Date(`${day}T00:00:00+05:00`).toISOString(), to: new Date(`${day}T23:59:59.999+05:00`).toISOString() }).set(auth(owner.token))).body.data;
    expect(await list(today)).toHaveLength(0);
    expect((await list(yesterday)).map((e: { _id: string }) => e._id)).toEqual([id]);

    const del = await request(app).delete(`/api/v1/expenses/${id}`).set(auth(owner.token));
    expect(del.status).toBe(200);
    expect(await list(yesterday)).toHaveLength(0);
  });

  it("cannot edit or delete another shop's expense", async () => {
    const a = await setup();
    const b = await setup();
    const exp = (await addExpense(a.owner, { category: 'Rent', amount: 100 })).body.data.expense;
    expect((await request(app).patch(`/api/v1/expenses/${exp._id}`).set(auth(b.owner.token)).send({ amount: 1 })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/expenses/${exp._id}`).set(auth(b.owner.token))).status).toBe(404);
  });

  it('rejects a malformed date filter', async () => {
    const { owner } = await setup();
    expect((await request(app).get('/api/v1/expenses?from=nope').set(auth(owner.token))).status).toBe(400);
  });
});

describe('Net Profit', () => {
  it("is today's profit minus today's expenditure, and follows add / edit / delete", async () => {
    const { owner, productId } = await setup();
    await sell(owner, productId, 10); // profit 10 × (250 − 200) = Rs 500

    let dash = await dashboard(owner);
    const profitCard = (await request(app).get('/api/v1/reports/profit-loss').set(auth(owner.token))).body.data.daily.profitMinor;
    expect(dash.profitMinor).toBe(profitCard); // same figure as the Profit card
    expect(dash.profitMinor).toBe(50000);
    expect(dash.expenses).toEqual({ totalMinor: 0, count: 0 });
    expect(dash.netProfitMinor).toBe(50000);

    const rent = (await addExpense(owner, { category: 'Rent', amount: 150 })).body.data.expense;
    await addExpense(owner, { category: 'Employee Pay', amount: 100 });
    dash = await dashboard(owner);
    expect(dash.expenses).toEqual({ totalMinor: 25000, count: 2 });
    expect(dash.netProfitMinor).toBe(25000);

    await request(app).patch(`/api/v1/expenses/${rent._id}`).set(auth(owner.token)).send({ amount: 450 });
    expect((await dashboard(owner)).netProfitMinor).toBe(50000 - 55000); // a net loss shows negative

    await request(app).delete(`/api/v1/expenses/${rent._id}`).set(auth(owner.token));
    expect((await dashboard(owner)).netProfitMinor).toBe(40000);
  });

  it("does not subtract other days' expenditure", async () => {
    const { owner, productId } = await setup();
    await sell(owner, productId, 4); // Rs 200 profit
    await addExpense(owner, { category: 'Rent', amount: 999, incurredAt: noonOf(yesterday) });
    const dash = await dashboard(owner);
    expect(dash.expenses.totalMinor).toBe(0);
    expect(dash.netProfitMinor).toBe(20000);
  });

  it('gives a daily-wise breakdown, each expense on its own day', async () => {
    const { owner, productId } = await setup();
    await sell(owner, productId, 6); // today: Rs 300 profit
    await addExpense(owner, { category: 'Electricity Bill', amount: 120, incurredAt: noonOf(today) });
    await addExpense(owner, { category: 'Rent', amount: 80, incurredAt: noonOf(yesterday) });

    const res = await request(app).get('/api/v1/reports/net-profit').query({ from: yesterday, to: today }).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.days.map((d: { date: string }) => d.date)).toEqual([today, yesterday]); // newest first
    const [t, y] = res.body.data.days;
    expect(t).toMatchObject({ profitMinor: 30000, expensesMinor: 12000, expenseCount: 1, netProfitMinor: 18000 });
    expect(y).toMatchObject({ profitMinor: 0, expensesMinor: 8000, netProfitMinor: -8000 });
    expect(res.body.data.totals).toEqual({ profitMinor: 30000, expensesMinor: 20000, netProfitMinor: 10000 });

    // Today's row matches the dashboard exactly.
    expect(t.netProfitMinor).toBe((await dashboard(owner)).netProfitMinor);
  });

  it('validates the requested range', async () => {
    const { owner } = await setup();
    const q = (query: Record<string, string>) => request(app).get('/api/v1/reports/net-profit').query(query).set(auth(owner.token));
    expect((await q({ from: 'bad', to: today })).status).toBe(400);
    expect((await q({ from: today, to: yesterday })).status).toBe(400);
    expect((await q({ from: '2025-01-01', to: '2026-01-01' })).status).toBe(400); // over 92 days
    expect((await q({})).body.data.days).toHaveLength(30); // default: last 30 days
  });
});
