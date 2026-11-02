import { ARMORY, levelOf } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armsOf, buyArms, logKill, recentKills, spendRounds } from './armory.ts';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import { balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await testDb('armory');
});
afterAll(async () => {
  await db.end();
});

async function player(cents: number): Promise<string> {
  n += 1;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'A') returning id",
    [`did:privy:arms-${Date.now()}-${n}`],
  );
  const id = (r.rows[0] as { id: string }).id;
  await transfer(db, {
    kind: 'signup_bonus',
    key: `fund-${id}`,
    legs: [
      { account: await systemAccount(db, 'faucet:signup'), amount: -cents },
      { account: await walletOf(db, id), amount: cents },
    ],
  });
  return id;
}

/** XP enough for `level`. */
function xpFor(level: number): number {
  let xp = 0;
  while (levelOf(xp).level < level) xp += 10;
  return xp;
}
const noGang = () => Promise.resolve(0);
const gang = () => Promise.resolve(ARMORY.blackMarketRank);
const key = () => `buy-${Date.now()}-${n++}`;
const fails = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BankError);
  expect((e as BankError).status).toBe(status);
};

describe('the armoury', () => {
  it('sells a licence from level 5, then the pistol and its rounds, each paid once', async () => {
    const id = await player(1_000_000);
    const buy = (item: string, xp = xpFor(5), k = key()) =>
      buyArms(db, noGang, { account: id, item, key: k, xp });
    await fails(buy('licence', xpFor(4)), 403);
    await fails(buy('pistol'), 403);
    expect((await buy('licence')).arms.licence).toBe(true);
    await fails(buy('pistol_rounds'), 400);
    const k = key();
    const [first, again] = await Promise.all([buy('pistol', 0, k), buy('pistol', 0, k)]);
    expect([first.status, again.status].sort()).toEqual(['duplicate', 'posted']);
    await fails(buy('pistol'), 400);
    for (let i = 0; i < 5; i += 1) await buy('pistol_rounds');
    expect((await armsOf(db, id)).rounds[1]).toBe(140);
    await fails(buy('pistol_rounds'), 400);
    expect(await balanceOf(db, await walletOf(db, id))).toBe(
      1_000_000 - ARMORY.licence.price - 350_000 - 5 * 5_600,
    );
  });

  it('keeps the rifle for gang members of rank, and spends rounds but never below none', async () => {
    const id = await player(2_000_000);
    await fails(buyArms(db, noGang, { account: id, item: 'rifle', key: key(), xp: 0 }), 403);
    await buyArms(db, gang, { account: id, item: 'rifle', key: key(), xp: 0 });
    await buyArms(db, gang, { account: id, item: 'rifle_rounds', key: key(), xp: 0 });
    expect(await armsOf(db, id)).toMatchObject({ weapons: [2], rounds: { 2: 90 } });
    expect((await spendRounds(db, { account: id, used: { 2: 30 } })).rounds[2]).toBe(60);
    expect((await spendRounds(db, { account: id, used: { 2: 500 } })).rounds[2]).toBeUndefined();
  });

  it('logs kills for staff, by character', async () => {
    const a = await player(100);
    await logKill(db, {
      killer: a,
      victim: null,
      killerName: 'Kim Shooter',
      victimName: 'Lee Target',
      weapon: 1,
      x: 3,
      z: 4,
    });
    const mine = await recentKills(db, 'kim shooter');
    expect(mine[0]).toMatchObject({ killer_name: 'Kim Shooter', victim_name: 'Lee Target' });
    expect(await recentKills(db, 'Nobody Here')).toEqual([]);
  });
});
