import { BUSINESSES, GOODS, JOB_RULES, USDC } from '@fr33world/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EconomyError, finishJob, reconcile, seedBusinesses, takeJob, tick } from './business.ts';
import type { Db } from './db.ts';
import { audit } from './ledger.ts';
import { SimChain as FakeChain } from './sim-chain.ts';
import { testDb } from './test-db.ts';

let db: Db;
let chain: FakeChain;
let alerts: string[];
const market = 'sunnys-grocery.test';
const wholesale = 'harbor-wholesale.test';
const farm = 'sol-farm.test';
const run = () => tick({ db, chain, alert: (t) => alerts.push(t), foodChain: true }, 0);
const stock = async (b: string, g: string) =>
  (
    await db.query<{ qty: number }>(
      'select qty from business_stock where business = $1 and good = $2',
      [b, g],
    )
  ).rows[0]!.qty;
const setStock = (b: string, g: string, qty: number) =>
  db.query('update business_stock set qty = $3 where business = $1 and good = $2', [b, g, qty]);

async function player(n: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'P') returning id",
    [`did:privy:${n}-${Date.now()}`],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await testDb('business');
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  chain = new FakeChain();
  alerts = [];
  await db.query(
    `truncate business_decisions, business_sales, business_jobs, business_orders,
       business_stock, businesses cascade`,
  );
  await seedBusinesses(db, chain);
});

describe('the economy', () => {
  it('starts with stock and no money', async () => {
    expect(await stock('market', 'meal')).toBe(60);
    expect(chain.wallets.size).toBe(0);
    await setStock('market', 'meal', 5);
    const r = await run();
    expect(r.ordered).toBe(0);
    expect(chain.orders.size).toBe(0);
  });

  it('never spends more than players put in', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 2 * USDC);
    for (let i = 0; i < 6; i += 1) await run();
    const held = [...chain.wallets.values()].reduce((s, w) => s + w.balance, 0);
    const paid = [...chain.paidTo.values()].reduce((s, n) => s + n, 0);
    expect(held + paid).toBe(2 * USDC);
    for (const w of chain.wallets.values()) expect(w.balance).toBeGreaterThanOrEqual(w.reserved);
  });

  it('restocks from its supplier when it can pay, and money moves down the chain', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 3 * USDC);
    const before = await stock('wholesale', 'meal');
    const r = await run();
    expect(r.ordered).toBe(1);
    expect(r.paid).toBe(1);
    expect((await chain.summary(wholesale)).balance).not.toBe('0');
    expect(await stock('wholesale', 'meal')).toBeLessThan(before);
    // The goods wait for a carrier; the local `$` supplier tops the shelf up meanwhile.
    expect(await stock('market', 'meal')).toBe(5 + 6);
  });

  it('trims an order to what it can afford', async () => {
    await setStock('market', 'meal', 0);
    const price = 150_000 * 1.15;
    chain.fund(market, Math.ceil((price * 2.5) / JOB_RULES.restockShare));
    await run();
    const o = await db.query<{ qty: number }>('select qty from business_orders');
    expect(o.rows[0]!.qty).toBe(2);
  });

  it('a timeout retries without paying twice', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 3 * USDC);
    chain.failNext = 1;
    await run();
    expect(chain.orders.size).toBe(0);
    await db.query('update business_orders set next_at = now()');
    await run();
    expect(chain.orders.size).toBe(1);
    const n = await db.query<{ n: number }>(
      "select count(*)::int as n from business_orders where status <> 'failed'",
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it('gives up an order the chain keeps refusing, and returns its goods', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 3 * USDC);
    chain.failNext = 99;
    await run();
    const q = await db.query<{ qty: number }>('select qty from business_orders');
    const taken = q.rows[0]!.qty;
    const left = await stock('wholesale', 'meal');
    await db.query(`update business_orders set attempts = $1, next_at = now()`, [
      JOB_RULES.maxAttempts - 1,
    ]);
    await run();
    const s = await db.query<{ status: string }>('select status from business_orders limit 1');
    expect(s.rows[0]!.status).toBe('failed');
    expect(await stock('wholesale', 'meal')).toBeGreaterThanOrEqual(left + taken - 1000);
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('keeps $ goods on the shelf with no USDC at all, the Hot Meal included', async () => {
    await setStock('market', 'water', 0);
    await setStock('market', 'meal', 0);
    await tick({ db, chain, alert: (t) => alerts.push(t) }, 0);
    expect(await stock('market', 'water')).toBe(6);
    expect(await stock('market', 'meal')).toBe(6);
    expect(await db.query('select 1 from business_orders')).toMatchObject({ rowCount: 0 });
  });

  it('pays a player for a delivery from money held on chain', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 8 * USDC);
    await run();
    const j = await db.query<{ id: string; amount: number }>(
      "select id, amount from business_jobs where status = 'open'",
    );
    const job = j.rows[0]!;
    expect((await chain.summary(market)).reserved).toBe(String(job.amount));
    const me = await player('driver');
    await takeJob(db, { account: me, near: 'me.test', jobId: job.id, level: 5, ageHours: 48 });
    await run();
    await finishJob(db, { account: me });
    await run();
    expect(chain.paidTo.get('me.test')).toBe(Number(job.amount));
    expect(await stock('market', 'meal')).toBeGreaterThan(5);
    expect((await chain.summary(market)).reserved).toBe('0');
  });

  it('keeps new and low-level players off USDC jobs', async () => {
    const me = await player('new');
    await expect(
      takeJob(db, { account: me, near: 'n.test', jobId: 'x', level: 1, ageHours: 48 }),
    ).rejects.toBeInstanceOf(EconomyError);
    await expect(
      takeJob(db, { account: me, near: 'n.test', jobId: 'x', level: 9, ageHours: 2 }),
    ).rejects.toBeInstanceOf(EconomyError);
  });

  it('only the player who took a job can finish it, once', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 8 * USDC);
    await run();
    const j = await db.query<{ id: string }>("select id from business_jobs where status = 'open'");
    const id = j.rows[0]!.id;
    const me = await player('a');
    const other = await player('b');
    await takeJob(db, { account: me, near: 'a.test', jobId: id, level: 5, ageHours: 48 });
    await run();
    await expect(finishJob(db, { account: other })).rejects.toBeInstanceOf(EconomyError);
    await finishJob(db, { account: me });
    await expect(finishJob(db, { account: me })).rejects.toBeInstanceOf(EconomyError);
  });

  it('frees the money when a player takes a job and vanishes', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 8 * USDC);
    await run();
    const j = await db.query<{ id: string }>("select id from business_jobs where status = 'open'");
    const me = await player('gone');
    await takeJob(db, {
      account: me,
      near: 'g.test',
      jobId: j.rows[0]!.id,
      level: 5,
      ageHours: 48,
    });
    await run();
    await db.query("update business_jobs set updated_at = now() - interval '2 hours'");
    await run();
    expect((await chain.summary(market)).reserved).toBe('0');
    expect(chain.paidTo.size).toBe(0);
    expect(await stock('market', 'meal')).toBeGreaterThan(5);
  });

  it('sends a van when nobody carries an order', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 8 * USDC);
    await run();
    await db.query("update business_orders set updated_at = now() - interval '7 hours'");
    await run();
    expect(await stock('market', 'meal')).toBeGreaterThan(5);
    expect((await chain.summary(market)).reserved).toBe('0');
  });

  it('flags a wallet that disagrees with the game', async () => {
    await run();
    chain.fund(farm, 0);
    chain.wallets.get(farm)!.reserved = 5;
    const bad = await reconcile({ db, chain, alert: (t) => alerts.push(t) });
    expect(bad).toBe(1);
    expect(alerts[0]).toContain('Sol Valley Farm');
  });

  it('runs at most once per gap, so a public trigger is harmless', async () => {
    await db.query('update economy_ticks set last_at = now()');
    const r = await tick({ db, chain, alert: () => {} }, 600);
    expect(r.ran).toBe(false);
  });

  it('has no effect on the $ ledger', async () => {
    await setStock('market', 'meal', 5);
    chain.fund(market, 8 * USDC);
    const before = await audit(db);
    await run();
    expect(await audit(db)).toEqual(before);
  });

  it('every business has goods and a wallet limit', () => {
    expect(GOODS.length).toBeGreaterThan(0);
    for (const b of BUSINESSES) expect(b.perPayment).toBeLessThanOrEqual(b.perDay);
  });
});
