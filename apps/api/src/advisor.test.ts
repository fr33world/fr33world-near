import { AI_LIMITS, BUSINESSES } from '@fr33world/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advise, type Ask, brief } from './advisor.ts';
import type { Db } from './db.ts';
import { testDb } from './test-db.ts';

let db: Db;
const market = BUSINESSES.find((b) => b.id === 'market')!;
const live = async () =>
  (
    await db.query<{ markup: string; target: number }>(
      "select markup, target from businesses where id = 'market'",
    )
  ).rows[0]!;
const run = (ask: Ask) => advise(db, ask, () => Promise.resolve(1_000_000));
const says =
  (o: unknown): Ask =>
  () =>
    Promise.resolve(JSON.stringify(o));

beforeAll(async () => {
  db = await testDb('advisor');
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate business_decisions, business_stock, businesses cascade');
  for (const b of BUSINESSES)
    await db.query(
      'insert into businesses (id, account, name, markup, target) values ($1, $2, $3, $4, $5)',
      [b.id, `${b.account}.test`, b.name, b.markup, b.target],
    );
});

describe('the AI advisor', () => {
  it('applies a small change and records why', async () => {
    await run(
      says({ markup: market.markup + 0.02, target: market.target + 5, reason: 'Selling fast.' }),
    );
    const m = await live();
    expect(Number(m.markup)).toBeCloseTo(market.markup + 0.02);
    expect(m.target).toBe(market.target + 5);
    const d = await db.query<{ summary: string }>(
      "select summary from business_decisions where business = 'market' and source = 'ai'",
    );
    expect(d.rows[0]!.summary).toBe('Selling fast.');
  });

  it('cuts a wild suggestion back to the limits', async () => {
    await run(says({ markup: 500, target: 1_000_000, reason: 'Go big' }));
    const m = await live();
    expect(Number(m.markup)).toBeCloseTo(market.markup + AI_LIMITS.markupStep);
    expect(m.target).toBe(Math.round(market.target * (1 + AI_LIMITS.targetStep)));
  });

  it('ignores nonsense and survives failure', async () => {
    await run(() => Promise.resolve('I think you should buy a boat'));
    await run(() => Promise.reject(new Error('down')));
    await run(says({ markup: 'lots', target: null }));
    const m = await live();
    expect(Number(m.markup)).toBeCloseTo(market.markup);
    expect(m.target).toBe(market.target);
  });

  it('strips markup out of a reason shown to players', async () => {
    await run(says({ markup: market.markup, target: market.target, reason: '<img src=x> ok' }));
    const d = await db.query<{ summary: string }>(
      "select summary from business_decisions where business = 'market'",
    );
    expect(d.rows[0]!.summary).not.toContain('<');
  });

  it('is told numbers only', () => {
    const text = brief(market, {
      markup: 0.3,
      target: 60,
      stock: 10,
      soldUsdc: 1,
      soldDollars: 2,
      freeUsdcMicro: 5,
    });
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(
      ['business', 'freeUsdcMicro', 'markup', 'soldDollars', 'soldUsdc', 'stock', 'target'].sort(),
    );
  });
});
