import {
  DAILY_TASKS,
  levelPrize,
  LOGIN_STREAK,
  nextStreak,
  SPIN,
  SPIN_TOTAL,
  spinPrize,
} from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armsOf } from './armory.ts';
import { claimDaily, dailyStatus } from './daily.ts';
import type { Db } from './db.ts';
import { balanceOf, walletOf } from './ledger.ts';
import { inTx } from './db.ts';
import { reward } from './rewards.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;

beforeAll(async () => {
  db = await testDb('daily');
});
afterAll(async () => {
  await db.end();
});

async function player(xp = 0) {
  n += 1;
  const privy = `did:privy:daily-${Date.now()}-${n}`;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [privy, `D${n}`],
  );
  const id = r.rows[0]!.id;
  await db.query(
    'insert into characters (account_id, name, age, appearance, xp) values ($1, $2, 25, 0, $3)',
    [id, `Daily Tester${n}`, xp],
  );
  return { id, privy };
}
const money = (id: string) => inTx(db, async (tx) => balanceOf(tx, await walletOf(tx, id)));

describe('the login streak', () => {
  it('runs day after day, restarts after a gap, and goes round after a week', () => {
    expect(nextStreak(null, '2026-11-07')).toBe(1);
    expect(nextStreak({ day: '2026-11-06', streak: 3 }, '2026-11-07')).toBe(4);
    expect(nextStreak({ day: '2026-11-05', streak: 3 }, '2026-11-07')).toBe(1);
    expect(nextStreak({ day: '2026-11-06', streak: LOGIN_STREAK.length }, '2026-11-07')).toBe(1);
  });

  it('pays once a day, however many taps', async () => {
    const p = await player();
    const before = await money(p.id);
    const tries = await Promise.allSettled([
      claimDaily(db, p.privy, { what: 'login' }),
      claimDaily(db, p.privy, { what: 'login' }),
    ]);
    expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(1);
    expect((await money(p.id)) - before).toBe(LOGIN_STREAK[0]!.cents);
    const s = await dailyStatus(db, p.privy);
    expect(s.login).toEqual({ claimed: true, streak: 1 });
  });
});

describe('the spin', () => {
  it('lands on each prize as often as its weight', () => {
    const hits = new Array<number>(SPIN.length).fill(0);
    for (let r = 0; r < SPIN_TOTAL; r += 1) hits[spinPrize(r)]! += 1;
    expect(hits).toEqual(SPIN.map((s) => s.weight));
  });

  it('is the server’s roll, once a day, and can put an item in the bag', async () => {
    const p = await player();
    const bandage = SPIN.findIndex((s) => s.item === 'bandage');
    const roll = SPIN.slice(0, bandage).reduce((a, s) => a + s.weight, 0);
    const r = await claimDaily(db, p.privy, { what: 'spin', slice: 0 } as never, () => roll);
    expect(r).toMatchObject({ slice: bandage, item: 'bandage' });
    expect((await armsOf(db, p.id)).care?.bandage).toBe(1);
    await expect(claimDaily(db, p.privy, { what: 'spin' })).rejects.toThrow(/Already/);
  });
});

describe('tasks and levels', () => {
  it('pays a task only once it is done', async () => {
    const p = await player();
    const work = DAILY_TASKS.find((t) => t.id === 'work')!;
    await expect(claimDaily(db, p.privy, { what: 'work' })).rejects.toThrow(/Not finished/);
    for (let i = 0; i < work.need; i += 1)
      await reward(db, {
        account: p.id,
        source: 'jobs',
        cents: 100,
        xp: 1,
        reason: 'Stop',
        key: `job-${p.id}-${i}`,
      });
    expect((await dailyStatus(db, p.privy)).tasks.find((t) => t.id === 'work')?.done).toBe(
      work.need,
    );
    await claimDaily(db, p.privy, { what: 'work' });
    await expect(claimDaily(db, p.privy, { what: 'work' })).rejects.toThrow(/Already/);
  });

  it('pays each level reached once, and none ahead of it', async () => {
    const p = await player(2_000);
    const s = await dailyStatus(db, p.privy);
    expect(s.levels.length).toBeGreaterThan(0);
    const l = s.levels[0]!;
    const before = await money(p.id);
    await claimDaily(db, p.privy, { what: 'level', level: l });
    expect((await money(p.id)) - before).toBe(levelPrize(l).cents);
    await expect(claimDaily(db, p.privy, { what: 'level', level: l })).rejects.toThrow(/Already/);
    await expect(claimDaily(db, p.privy, { what: 'level', level: 99 })).rejects.toThrow(
      /Not reached/,
    );
    expect((await dailyStatus(db, p.privy)).levels).not.toContain(l);
  });
});

describe('claims', () => {
  it('turns down what doesn’t exist', async () => {
    const p = await player();
    await expect(claimDaily(db, p.privy, { what: 'usdc' })).rejects.toThrow(/Nothing like that/);
  });
});
