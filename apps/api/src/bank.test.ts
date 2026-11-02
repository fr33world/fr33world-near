import { PAYMENTS } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankError, pay, statement } from './bank.ts';
import type { Db } from './db.ts';
import { audit, setFrozen, systemAccount, transfer, walletOf } from './ledger.ts';
import { pauseEconomy, resumeEconomy } from './monitor.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;

beforeAll(async () => {
  db = await testDb('bank');
});
afterAll(async () => {
  await db.end();
});

/** A player with a character `hoursOld` hours old and `cents` in the bank; their Privy id. */
async function player(
  name: string,
  cents = 0,
  opts: { hoursOld?: number; guest?: boolean } = {},
): Promise<{ privy: string; id: string; name: string }> {
  n += 1;
  const privy = `did:privy:bank-${Date.now()}-${n}`;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name, is_guest) values ($1, $2, $3) returning id',
    [privy, name, opts.guest ?? false],
  );
  const id = (r.rows[0] as { id: string }).id;
  const full = `${name} Payer${n}`;
  await db.query(
    `insert into characters (account_id, name, age, appearance, created_at)
     values ($1, $2, 30, 0, now() - make_interval(hours => $3))`,
    [id, full, opts.hoursOld ?? 48],
  );
  if (cents > 0)
    await transfer(db, {
      kind: 'signup_bonus',
      key: `fund-${id}`,
      legs: [
        { account: await systemAccount(db, 'faucet:signup'), amount: -cents },
        { account: await walletOf(db, id), amount: cents },
      ],
    });
  return { privy, id, name: full };
}

const key = () => `k${Date.now()}${n++}xyz`;
const fails = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BankError);
  expect((e as BankError).status).toBe(status);
};

describe('the bank', () => {
  it('pays another character by name, once per request id, and shows both histories', async () => {
    const a = await player('Ana', 10_000);
    const b = await player('Bo');
    const k = key();
    const sent = await pay(db, a.privy, {
      to: b.name.toUpperCase(),
      cents: 2_500,
      note: ' for\nlunch ',
      key: k,
    });
    expect(sent).toMatchObject({ status: 'posted', balance: 7_500, to: b.name });
    expect(
      await pay(db, a.privy, { to: b.name, cents: 2_500, note: 'for lunch', key: k }),
    ).toMatchObject({
      status: 'duplicate',
      balance: 7_500,
    });
    const mine = await statement(db, a.privy);
    expect(mine.history[0]).toMatchObject({
      kind: 'payment',
      amount: -2_500,
      other: b.name,
      note: 'for lunch',
    });
    const theirs = await statement(db, b.privy);
    expect(theirs).toMatchObject({ balance: 2_500, frozen: false });
    expect(theirs.history[0]).toMatchObject({ amount: 2_500, other: a.name });
  });

  it('refuses bad amounts, unknown or self recipients, and overdrafts', async () => {
    const a = await player('Cy', 1_000);
    const b = await player('Di');
    for (const cents of [0, -100, 50, 12.5, PAYMENTS.max + 1, Number.NaN, '100'])
      await fails(pay(db, a.privy, { to: b.name, cents, key: key() }), 400);
    await fails(pay(db, a.privy, { to: 'Nobody Atall', cents: 500, key: key() }), 404);
    await fails(pay(db, a.privy, { to: a.name, cents: 500, key: key() }), 400);
    await fails(pay(db, a.privy, { to: b.name, cents: 5_000, key: key() }), 402);
    await fails(pay(db, a.privy, { to: b.name, cents: 500, key: 'short' }), 400);
    expect((await statement(db, a.privy)).balance).toBe(1_000);
  });

  it('keeps guests and brand-new characters from sending', async () => {
    const g = await player('Guest', 10_000, { guest: true });
    const fresh = await player('Newbie', 10_000, { hoursOld: 1 });
    const b = await player('Eli');
    await fails(pay(db, g.privy, { to: b.name, cents: 500, key: key() }), 403);
    await fails(pay(db, fresh.privy, { to: b.name, cents: 500, key: key() }), 403);
  });

  it('limits payments per hour and money per day, even when racing', async () => {
    const a = await player('Fay', 50_000_000);
    const b = await player('Gus');
    const results = await Promise.allSettled(
      Array.from({ length: PAYMENTS.perHour + 5 }, () =>
        pay(db, a.privy, { to: b.name, cents: 100, key: key() }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(PAYMENTS.perHour);
    const c = await player('Hal', 50_000_000);
    for (let i = 0; i < 4; i += 1)
      await pay(db, c.privy, { to: b.name, cents: PAYMENTS.max, key: key() });
    await fails(pay(db, c.privy, { to: b.name, cents: PAYMENTS.max, key: key() }), 429);
  });

  it('stops while the wallet is frozen or the economy paused, and the books stay closed', async () => {
    const a = await player('Ida', 10_000);
    const b = await player('Jay');
    await setFrozen(db, await walletOf(db, a.id), true);
    await fails(pay(db, a.privy, { to: b.name, cents: 500, key: key() }), 403);
    expect((await statement(db, a.privy)).frozen).toBe(true);
    await setFrozen(db, await walletOf(db, a.id), false);
    await pauseEconomy(db, 'test');
    await fails(pay(db, a.privy, { to: b.name, cents: 500, key: key() }), 503);
    await resumeEconomy(db, 'test');
    await pay(db, a.privy, { to: b.name, cents: 500, key: key() });
    expect(await audit(db)).toMatchObject({ total: 0, drifted: 0, unbalanced: 0 });
  });
});
