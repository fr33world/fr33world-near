import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { correct, freeze, lookUp, reverse } from './corrections.ts';
import type { Db } from './db.ts';
import { audit as books, transfer, walletOf } from './ledger.ts';
import { pauseEconomy, resumeEconomy } from './monitor.ts';
import { recentAudit, StaffError } from './staff.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
const supers = new Set(['ada byron']);

beforeAll(async () => {
  db = await testDb('corrections');
});
afterAll(async () => {
  await db.end();
});

async function player(name: string): Promise<string> {
  n += 1;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [`did:privy:corr-${Date.now()}-${n}`, name],
  );
  const id = (r.rows[0] as { id: string }).id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 30, 0)',
    [id, name],
  );
  return id;
}

const refused = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(StaffError);
  expect((e as StaffError).status).toBe(status);
};

describe('admin corrections', () => {
  it('add and take back money only with a reason, never below zero, all audited', async () => {
    const boss = await player('Ada Byron');
    await player('Ola Corrected');
    expect(
      await correct(
        db,
        boss,
        { name: 'ola corrected', cents: 10_000, reason: 'lost car refund' },
        supers,
      ),
    ).toMatchObject({
      name: 'Ola Corrected',
      balance: 10_000,
    });
    await refused(
      correct(db, boss, { name: 'Ola Corrected', cents: 500, reason: '' }, supers),
      400,
    );
    await refused(
      correct(db, boss, { name: 'Ola Corrected', cents: -20_000, reason: 'exploit' }, supers),
      409,
    );
    expect(
      (
        await correct(
          db,
          boss,
          { name: 'Ola Corrected', cents: -4_000, reason: 'double pay' },
          supers,
        )
      ).balance,
    ).toBe(6_000);
    const log = await recentAudit(db);
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['money']));
    expect(await books(db)).toMatchObject({ total: 0, drifted: 0, unbalanced: 0 });
  });

  it('reverse a transaction once, and only for staff with the money power', async () => {
    const boss = await player('Ada Byron2');
    const mod = await player('Mod Person');
    await db.query(
      "insert into staff (account_id, permissions, added_by) values ($1, '{kick}', $2)",
      [mod, boss],
    );
    const a = await player('Pay Er');
    const b = await player('Pay Ee');
    const s = new Set(['ada byron2']);
    await correct(db, boss, { name: 'Pay Er', cents: 5_000, reason: 'start money' }, s);
    const { txId } = await transfer(db, {
      kind: 'payment',
      key: `p-${a}`,
      legs: [
        { account: await walletOf(db, a), amount: -3_000 },
        { account: await walletOf(db, b), amount: 3_000 },
      ],
    });
    await refused(reverse(db, mod, { tx: txId, reason: 'scam' }, s), 403);
    await pauseEconomy(db, 'testing');
    // Corrections still go through while paused.
    expect(await reverse(db, boss, { tx: txId, reason: 'scam payment' }, s)).toMatchObject({
      legs: 2,
    });
    await resumeEconomy(db, 'test');
    await refused(reverse(db, boss, { tx: txId, reason: 'again' }, s), 409);
    expect((await lookUp(db, boss, { name: 'Pay Er' }, s)).balance).toBe(5_000);
    expect((await lookUp(db, boss, { name: 'Pay Ee' }, s)).balance).toBe(0);
  });

  it('freeze and thaw a wallet', async () => {
    const boss = await player('Ada Byron3');
    await player('Ice Cold');
    const s = new Set(['ada byron3']);
    expect(await freeze(db, boss, { name: 'Ice Cold', reason: 'review' }, s)).toEqual({
      name: 'Ice Cold',
      frozen: true,
    });
    expect((await lookUp(db, boss, { name: 'Ice Cold' }, s)).frozen).toBe(true);
    await freeze(db, boss, { name: 'Ice Cold', frozen: false }, s);
    expect((await lookUp(db, boss, { name: 'Ice Cold' }, s)).frozen).toBe(false);
  });
});
