import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, inTx } from './db.ts';
import { earn } from './economy.ts';
import { audit, EconomyPaused, post, systemAccount, walletOf } from './ledger.ts';
import { check, economyState, recentAlerts, resumeEconomy } from './monitor.ts';
import { testDb } from './test-db.ts';

let db: Db;

beforeAll(async () => {
  db = await testDb('monitor');
});
afterAll(async () => {
  await db.end();
});

async function player(): Promise<string> {
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [`did:privy:mon-${Date.now()}-${Math.random()}`, 'Mo Nitor'],
  );
  return (r.rows[0] as { id: string }).id;
}

describe('the invariant monitor', () => {
  it('passes clean books and leaves the economy running', async () => {
    const p = await player();
    await inTx(db, (tx) => earn(tx, { accountId: p, faucet: 'jobs', cents: 500, key: `m-${p}` }));
    expect(await check(db)).toMatchObject({ ok: true, problems: [] });
    expect((await economyState(db)).paused).toBe(false);
  });

  it('pauses on wrong books: the database then refuses all but corrections', async () => {
    const p = await player();
    const broken = async (d: Db) => ({ ...(await audit(d)), total: 1234 });
    const found = await check(db, broken);
    expect(found.ok).toBe(false);
    expect(await economyState(db)).toMatchObject({ paused: true });
    expect((await recentAlerts(db))[0]).toMatchObject({ kind: 'paused' });
    await expect(
      inTx(db, (tx) => earn(tx, { accountId: p, faucet: 'jobs', cents: 100, key: `p-${p}` })),
    ).rejects.toBeInstanceOf(EconomyPaused);
    // An admin's correction still goes through.
    const wallet = await walletOf(db, p);
    const faucet = await systemAccount(db, 'faucet:corrections');
    await inTx(db, (tx) =>
      post(tx, {
        kind: 'correction',
        key: `c-${p}`,
        actor: 'staff:test',
        legs: [
          { account: faucet, amount: -10 },
          { account: wallet, amount: 10 },
        ],
      }),
    );
    await resumeEconomy(db, 'test');
    expect((await economyState(db)).paused).toBe(false);
    await inTx(db, (tx) => earn(tx, { accountId: p, faucet: 'jobs', cents: 100, key: `q-${p}` }));
  });
});
