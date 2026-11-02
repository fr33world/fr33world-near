import type { Faucet } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, inTx } from './db.ts';
import { earn, FaucetCapped, spend } from './economy.ts';
import { audit, balanceOf, InsufficientFunds, LedgerError, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;

async function newPlayer(): Promise<string> {
  n += 1;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [`did:privy:econ-${Date.now()}-${n}`, `Player ${n}`],
  );
  return (r.rows[0] as { id: string }).id;
}
const balance = async (id: string) => balanceOf(db, await walletOf(db, id));

/** Small caps, so tests reach them quickly. */
const TEST: Record<string, Faucet> = {
  jobs: {
    account: 'faucet:jobs',
    about: 'Job pay',
    maxPayment: 500,
    perHour: 1_000,
    perDay: 1_500,
  },
};

beforeAll(async () => {
  db = await testDb('economy');
});
afterAll(async () => {
  await db.end();
});

describe('faucets and their caps', () => {
  it('pays what is asked until the hourly cap, then the rest of it, then nothing', async () => {
    const p = await newPlayer();
    const pay = (cents: number, key: string) =>
      inTx(db, (tx) => earn(tx, { accountId: p, faucet: 'jobs', cents, key }, TEST));
    expect(await pay(500, 'a')).toMatchObject({ paid: 500, capped: false });
    expect(await pay(400, 'b')).toMatchObject({ paid: 400, capped: false });
    expect(await pay(300, 'c')).toMatchObject({ paid: 100, capped: true });
    await expect(pay(100, 'd')).rejects.toBeInstanceOf(FaucetCapped);
    expect(await balance(p)).toBe(1_000);
  });

  it('answers a replayed payout with what it paid, even past the cap', async () => {
    const p = await newPlayer();
    const pay = (cents: number, key: string) =>
      inTx(db, (tx) => earn(tx, { accountId: p, faucet: 'jobs', cents, key }, TEST));
    await pay(500, `x-${p}`);
    await pay(500, `y-${p}`);
    expect(await pay(500, `x-${p}`)).toMatchObject({ status: 'duplicate', paid: 500 });
    expect(await balance(p)).toBe(1_000);
  });

  it('never lets racing payouts past the cap', async () => {
    const p = await newPlayer();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        inTx(db, (tx) =>
          earn(tx, { accountId: p, faucet: 'jobs', cents: 300, key: `race-${p}-${i}` }, TEST),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0);
    expect(await balance(p)).toBe(1_000);
  });

  it('refuses amounts no faucet pays: zero, negative, fractions, above the largest payment', async () => {
    const p = await newPlayer();
    for (const cents of [0, -50, 12.5, 501, Number.MAX_SAFE_INTEGER, Number.NaN]) {
      await expect(
        inTx(db, (tx) =>
          earn(tx, { accountId: p, faucet: 'jobs', cents, key: `bad-${p}-${cents}` }, TEST),
        ),
      ).rejects.toBeInstanceOf(LedgerError);
    }
    expect(await balance(p)).toBe(0);
  });

  it('charges into a sink, never below zero, and keeps the books closed', async () => {
    const p = await newPlayer();
    await inTx(db, (tx) =>
      earn(tx, { accountId: p, faucet: 'jobs', cents: 400, key: `s-${p}` }, TEST),
    );
    const charge = (cents: number, key: string) =>
      inTx(db, (tx) => spend(tx, { accountId: p, sink: 'fees', cents, key, kind: 'hospital' }));
    await charge(150, `h1-${p}`);
    await expect(charge(300, `h2-${p}`)).rejects.toBeInstanceOf(InsufficientFunds);
    expect(await balance(p)).toBe(250);
    const a = await audit(db);
    expect(a).toMatchObject({ total: 0, drifted: 0, unbalanced: 0 });
  });
});
