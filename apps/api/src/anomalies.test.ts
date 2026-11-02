import { ANOMALY } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openFlags, reviewFlag, scan } from './anomalies.ts';
import { type Db, inTx } from './db.ts';
import { earn } from './economy.ts';
import { AccountFrozen, post, systemAccount, transfer, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;

beforeAll(async () => {
  db = await testDb('anomalies');
});
afterAll(async () => {
  await db.end();
});

async function player(name: string): Promise<string> {
  n += 1;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [`did:privy:an-${Date.now()}-${n}`, name],
  );
  const id = (r.rows[0] as { id: string }).id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 25, 0)',
    [id, `${name} Tester${n}`],
  );
  return id;
}

async function give(id: string, cents: number) {
  const faucet = await systemAccount(db, 'faucet:corrections');
  await transfer(db, {
    kind: 'correction',
    key: `give-${id}-${n++}`,
    legs: [
      { account: faucet, amount: -cents },
      { account: await walletOf(db, id), amount: cents },
    ],
  });
}

async function pay(from: string, to: string, cents: number) {
  await transfer(db, {
    kind: 'payment',
    key: `pay-${from}-${n++}`,
    legs: [
      { account: await walletOf(db, from), amount: -cents },
      { account: await walletOf(db, to), amount: cents },
    ],
  });
}

const kinds = async (id: string) =>
  (await openFlags(db))
    .filter((f) => f.account === id)
    .map((f) => f.kind)
    .sort();

/** Low thresholds, so a few postings reach them. */
const LOW = {
  ...ANOMALY,
  earnedPerHour: 600,
  largeBalance: 50_000,
  pairPayments: 3,
  fanIn: 3,
  roundTrip: 1_000,
};

describe('anomaly flags', () => {
  it('flags earning faster than the caps allow, and a large balance', async () => {
    const fast = await player('Fast');
    await inTx(db, (tx) =>
      earn(tx, { accountId: fast, faucet: 'jobs', cents: 500, key: `f1-${fast}` }),
    );
    await inTx(db, (tx) =>
      earn(tx, { accountId: fast, faucet: 'salary', cents: 300, key: `f2-${fast}` }),
    );
    const rich = await player('Rich');
    await give(rich, 60_000);
    await scan(db, LOW);
    expect(await kinds(fast)).toEqual(['velocity']);
    expect(await kinds(rich)).toEqual(['large_balance']);
  });

  it('flags many payments between two players, a funnel, and money sent back', async () => {
    const [a, b, c, d, hub] = await Promise.all(['Ann', 'Ben', 'Cal', 'Dee', 'Hub'].map(player));
    for (const p of [a, b, c, d]) await give(p as string, 10_000);
    for (let i = 0; i < 3; i += 1) await pay(a as string, b as string, 100);
    for (const p of [b, c, d]) await pay(p as string, hub as string, 200);
    await pay(c as string, d as string, 2_000);
    await pay(d as string, c as string, 1_500);
    await scan(db, LOW);
    expect(await kinds(a as string)).toEqual(['pair']);
    expect(await kinds(hub as string)).toEqual(['fan_in']);
    expect(await kinds(c as string)).toEqual(['round_trip']);
  });

  it('keeps one open flag per kind, and a review can freeze the wallet', async () => {
    const rich = await player('Gold');
    await give(rich, 70_000);
    await scan(db, LOW);
    await scan(db, LOW);
    const mine = (await openFlags(db)).filter((f) => f.account === rich);
    expect(mine).toHaveLength(1);
    expect(
      await reviewFlag(db, mine[0]?.id ?? 0, 'staff:test', { note: 'checking', freeze: true }),
    ).toBe(true);
    expect(await kinds(rich)).toEqual([]);
    const sink = await systemAccount(db, 'sink:fees');
    await expect(
      inTx(db, async (tx) =>
        post(tx, {
          kind: 'fee',
          key: `fee-${rich}`,
          legs: [
            { account: await walletOf(tx, rich), amount: -100 },
            { account: sink, amount: 100 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(AccountFrozen);
  });
});
