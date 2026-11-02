import { TUTORIAL_REWARD } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.ts';
import { balanceOf, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';
import { advanceTutorial } from './tutorial.ts';

let db: Db;
let n = 0;

beforeAll(async () => {
  db = await testDb('tutorial');
});
afterAll(async () => {
  await db.end();
});

async function player(): Promise<{ privy: string; id: string }> {
  const k = (n += 1);
  const privy = `did:privy:tut-${Date.now()}-${k}`;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [privy, `T${k}`],
  );
  const id = (r.rows[0] as { id: string }).id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 22, 0)',
    [id, `Tutorial Tester${k}`],
  );
  return { privy, id };
}

describe('the tutorial', () => {
  it('saves progress forward only, and pays once when done', async () => {
    const p = await player();
    expect(await advanceTutorial(db, p.privy, { step: 'move' })).toMatchObject({ step: 'move' });
    // Backwards is ignored.
    expect(await advanceTutorial(db, p.privy, { step: 'welcome' })).toMatchObject({ step: 'move' });
    const done = await advanceTutorial(db, p.privy, { step: 'done' });
    expect(done.reward).toMatchObject({ cents: TUTORIAL_REWARD.cents, xp: TUTORIAL_REWARD.xp });
    expect(await advanceTutorial(db, p.privy, { step: 'done' })).toMatchObject({ reward: null });
    expect(await balanceOf(db, await walletOf(db, p.id))).toBe(TUTORIAL_REWARD.cents);
  });

  it('can be skipped (no reward), and stays over', async () => {
    const p = await player();
    await advanceTutorial(db, p.privy, { step: 'skipped' });
    expect(await advanceTutorial(db, p.privy, { step: 'done' })).toMatchObject({
      step: 'skipped',
      reward: null,
    });
    await expect(advanceTutorial(db, p.privy, { step: 'hack' })).rejects.toThrow();
  });
});
