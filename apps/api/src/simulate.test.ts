import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.ts';
import { simulate } from './simulate.ts';
import { testDb } from './test-db.ts';

let db: Db;

beforeAll(async () => {
  db = await testDb('simulate');
});
afterAll(async () => {
  await db.end();
});

describe('the economy simulator (Phase 5 gate)', () => {
  it('finds no way to create, duplicate or overdraw money', { timeout: 60_000 }, async () => {
    const report = await simulate(db, { players: 24, rounds: 30, burst: 12, seed: 7 });
    expect(report.problems).toEqual([]);
    // It really exercised the rules: payouts, refusals (caps, overdrafts), payments, replays.
    expect(report.actions.job.done).toBeGreaterThan(0);
    expect(report.actions.pay.done).toBeGreaterThan(0);
    expect(report.actions.buy.refused).toBeGreaterThan(0);
    expect(report.actions.replay.done).toBeGreaterThan(0);
    expect(report.actions.junk.done).toBe(0);
  });
});
