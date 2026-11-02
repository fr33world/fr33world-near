import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import { chargeFare } from './fares.ts';
import { balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await testDb('fares');
});
afterAll(async () => {
  await db.end();
});

async function rider(cents: number): Promise<string> {
  n += 1;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'R') returning id",
    [`did:privy:fare-${Date.now()}-${n}`],
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

const fails = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BankError);
  expect((e as BankError).status).toBe(status);
};

describe('fares', () => {
  it('charges a taxi fare into the purchases sink, once per ride', async () => {
    const account = await rider(10_000);
    const sink = await systemAccount(db, 'sink:purchases');
    const before = await balanceOf(db, sink);
    const ride = { account, cents: 1_250, key: 'ride-0001', kind: 'taxi', to: 'Car Dealership' };
    const all = await Promise.all([chargeFare(db, ride), chargeFare(db, ride)]);
    expect(all.map((r) => r.status).sort()).toEqual(['duplicate', 'posted']);
    expect(all[0]?.balance).toBe(8_750);
    expect((await balanceOf(db, sink)) - before).toBe(1_250);
  });

  it('turns down other kinds, bad amounts and riders who cannot pay', async () => {
    const account = await rider(500);
    await fails(chargeFare(db, { account, cents: 100, key: 'ride-0002', kind: 'gift' }), 400);
    await fails(chargeFare(db, { account, cents: -100, key: 'ride-0003', kind: 'taxi' }), 400);
    await fails(chargeFare(db, { account, cents: 999_999, key: 'ride-0004', kind: 'taxi' }), 400);
    await fails(chargeFare(db, { account, cents: 600, key: 'ride-0005', kind: 'taxi' }), 402);
    expect(await balanceOf(db, await walletOf(db, account))).toBe(500);
  });
});
