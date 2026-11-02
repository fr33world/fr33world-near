import { CAR_MODELS, carPrice, DEALER, RENTAL } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import { buyCar, garageOf, saveCondition, STARTER_MODEL } from './garage.ts';
import { audit, balanceOf, setFrozen, systemAccount, transfer, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await testDb('garage');
});
afterAll(async () => {
  await db.end();
});

/** A player with a character and `cents` in the bank; their Privy id and account. */
async function buyer(cents: number): Promise<{ privy: string; id: string }> {
  n += 1;
  const privy = `did:privy:dealer-${Date.now()}-${n}`;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'B') returning id",
    [privy],
  );
  const id = (r.rows[0] as { id: string }).id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 30, 0)',
    [id, `Buyer Number${n}`],
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
  return { privy, id };
}

const model = (id: string) => CAR_MODELS.findIndex((m) => m.id === id);
const key = () => `buy-${Date.now()}-${n++}`;
const fails = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BankError);
  expect((e as BankError).status).toBe(status);
};

describe('the garage', () => {
  it('gives every account one starter car, once, however many ask at once', async () => {
    const r = await db.query<{ id: string }>(
      "insert into accounts (privy_user_id, display_name) values ('did:privy:garage-1', 'G') returning id",
    );
    const id = (r.rows[0] as { id: string }).id;
    const all = await Promise.all(Array.from({ length: 8 }, () => garageOf(db, id)));
    for (const cars of all) expect(cars).toHaveLength(1);
    expect(all[0]?.[0]).toMatchObject({ model: STARTER_MODEL, name: 'Compact' });
  });
});

describe('the newcomer’s rental', () => {
  it('lasts three days, then goes back for good and frees its space', async () => {
    const b = await buyer(carPrice(model('compact')) as number);
    const [rental] = await garageOf(db, b.id);
    expect(rental).toMatchObject({ model: STARTER_MODEL, name: 'Compact' });
    const due = new Date(rental?.expiresAt ?? 0).getTime() - Date.now();
    expect(due).toBeGreaterThan(RENTAL.days * 86_400_000 - 60_000);
    expect(due).toBeLessThanOrEqual(RENTAL.days * 86_400_000);
    // Due back: gone, and not given again.
    await db.query(
      "update owned_cars set expires_at = now() - interval '1 minute' where account_id = $1",
      [b.id],
    );
    expect(await garageOf(db, b.id)).toEqual([]);
    expect(await garageOf(db, b.id)).toEqual([]);
    // A car bought is the player's own, with no due date.
    const bought = await buyCar(db, b.privy, { model: model('compact'), key: key() });
    expect(bought.car.expiresAt).toBeNull();
    expect(await garageOf(db, b.id)).toHaveLength(1);
  });
});

describe('car condition', () => {
  it('keeps a car’s fuel and condition in the garage, only for its owner', async () => {
    const b = await buyer(0);
    const [car] = await garageOf(db, b.id);
    expect(car).toMatchObject({ fuel: 1, health: 1 });
    const id = (car as { id: number }).id;
    expect(await saveCondition(db, { account: b.id, car: id, fuel: 0.25, health: 0.5 })).toBe(true);
    expect((await garageOf(db, b.id))[0]).toMatchObject({ fuel: 0.25, health: 0.5 });
    const other = await buyer(0);
    expect(await saveCondition(db, { account: other.id, car: id, fuel: 1, health: 1 })).toBe(false);
    await expect(
      saveCondition(db, { account: b.id, car: id, fuel: 2, health: 1 }),
    ).rejects.toThrow();
  });
});

describe('the dealership', () => {
  it('sells a car: the price into the purchases sink, the car into the garage', async () => {
    const coupe = model('coupe');
    const price = carPrice(coupe) as number;
    const b = await buyer(price + 1_000);
    const sink = await systemAccount(db, 'sink:purchases');
    const before = await balanceOf(db, sink);
    const bought = await buyCar(db, b.privy, { model: coupe, key: key() });
    expect(bought).toMatchObject({ status: 'posted', balance: 1_000, car: { model: coupe } });
    expect(bought.car.name).toBe('Coupe');
    expect((await balanceOf(db, sink)) - before).toBe(price);
    // The starter car and the new one.
    const cars = await garageOf(db, b.id);
    expect(cars.map((c) => c.model)).toEqual([STARTER_MODEL, coupe]);
    const books = await audit(db);
    expect(books).toMatchObject({ total: 0, drifted: 0, unbalanced: 0 });
  });

  it('a purchase replayed, even all at once, pays once and gives one car', async () => {
    const sedan = model('sedan');
    const price = carPrice(sedan) as number;
    const b = await buyer(price * 3);
    const k = key();
    const all = await Promise.all(
      Array.from({ length: 12 }, () => buyCar(db, b.privy, { model: sedan, key: k })),
    );
    expect(all.filter((r) => r.status === 'posted')).toHaveLength(1);
    expect(new Set(all.map((r) => Number(r.car.id))).size).toBe(1);
    expect(await garageOf(db, b.id)).toHaveLength(2);
    expect(await balanceOf(db, await walletOf(db, b.id))).toBe(price * 2);
    // The same key for another car is refused, not a free swap.
    await fails(buyCar(db, b.privy, { model: model('wagon'), key: k }), 409);
  });

  it('turns down what it cannot sell, what the player cannot afford, and bad requests', async () => {
    const b = await buyer(100_000);
    await fails(buyCar(db, b.privy, { model: model('police'), key: key() }), 400);
    await fails(buyCar(db, b.privy, { model: 99, key: key() }), 400);
    await fails(buyCar(db, b.privy, { model: '3', key: key() }), 400);
    await fails(buyCar(db, b.privy, { model: model('compact'), key: 'x' }), 400);
    await fails(buyCar(db, b.privy, { model: model('compact'), key: key() }), 402);
    await fails(buyCar(db, 'did:privy:nobody', { model: model('compact'), key: key() }), 401);
    // Nothing was taken and nothing given.
    expect(await balanceOf(db, await walletOf(db, b.id))).toBe(100_000);
    expect(await garageOf(db, b.id)).toHaveLength(1);
  });

  it('stops at a full garage, and not while the wallet is frozen', async () => {
    const compact = model('compact');
    const price = carPrice(compact) as number;
    const b = await buyer(price * (DEALER.garageMax + 1));
    // Racing for the last places: never more than the limit.
    const tries = await Promise.allSettled(
      Array.from({ length: DEALER.garageMax + 2 }, () =>
        buyCar(db, b.privy, { model: compact, key: key() }),
      ),
    );
    expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(DEALER.garageMax - 1);
    expect(await garageOf(db, b.id)).toHaveLength(DEALER.garageMax);
    await fails(buyCar(db, b.privy, { model: compact, key: key() }), 409);

    const c = await buyer(price * 2);
    await setFrozen(db, await walletOf(db, c.id), true);
    await fails(buyCar(db, c.privy, { model: compact, key: key() }), 403);
  });
});
