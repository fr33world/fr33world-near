import { levelOf, XP_SOURCES } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.ts';
import { balanceOf, walletOf } from './ledger.ts';
import { reward, RewardError } from './rewards.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;

beforeAll(async () => {
  db = await testDb('rewards');
});
afterAll(async () => {
  await db.end();
});

async function player(): Promise<string> {
  const k = (n += 1);
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [`did:privy:rw-${Date.now()}-${k}`, `R${k}`],
  );
  const id = (r.rows[0] as { id: string }).id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 25, 0)',
    [id, `Reward Tester${k}`],
  );
  return id;
}

describe('rewards', () => {
  it('give money and XP together, once per key, and level up', async () => {
    const p = await player();
    const give = (key: string) =>
      reward(db, { account: p, source: 'jobs', cents: 2_000, xp: 60, reason: 'Delivery', key });
    expect(await give('drop-1')).toMatchObject({ status: 'given', cents: 2_000, xp: 60, level: 1 });
    expect(await give('drop-1')).toMatchObject({ status: 'duplicate', cents: 2_000, xp: 60 });
    const second = await give('drop-2');
    expect(second).toMatchObject({ totalXp: 120, level: 2, levelUp: true });
    expect(await balanceOf(db, await walletOf(db, p))).toBe(4_000);
  });

  it('cap XP per hour, and refuse junk', async () => {
    const p = await player();
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = await reward(db, { account: p, source: 'jobs', xp: 150, key: `xp-${p}-${i}` });
      total += r.xp;
    }
    expect(total).toBe(XP_SOURCES.jobs.perHour);
    for (const bad of [
      { source: 'cheat', xp: 10 },
      { source: 'jobs', xp: 151 },
      { source: 'jobs', xp: -5 },
      { source: 'jobs', cents: -100 },
      { source: 'jobs', xp: 1.5 },
    ])
      await expect(
        reward(db, { account: p, key: `bad-${Math.random()}`, ...bad }),
      ).rejects.toBeInstanceOf(RewardError);
    expect(levelOf(total).level).toBeGreaterThan(1);
  });
});
