import { carPrice, CAR_MODELS, MARKET } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import { buyCar } from './garage.ts';
import { balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { buyListed, listCar, listings, priceBounds, withdraw } from './market.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await testDb('market');
});
afterAll(async () => {
  await db.end();
});

async function person(cents: number, guest = false) {
  // Its own number, even when several are made at once.
  const k = (n += 1);
  const privy = `did:privy:mkt-${Date.now()}-${k}`;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name, is_guest) values ($1, 'M', $2) returning id",
    [privy, guest],
  );
  const id = (r.rows[0] as { id: string }).id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 30, 0)',
    [id, `Trader Number${k}`],
  );
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
const fails = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BankError);
  expect((e as BankError).status).toBe(status);
};

describe('the car market', () => {
  it('sells a car between players for $, less the fee', async () => {
    const sedan = model('sedan');
    const seller = await person(carPrice(sedan) as number);
    const buyer = await person(5_000_000);
    const { car } = await buyCar(db, seller.privy, { model: sedan, key: `k-${Date.now()}-${n}` });
    const { min, max } = priceBounds(sedan);
    await fails(listCar(db, seller.privy, { car: car.id, price: min - 1 }), 400);
    await fails(listCar(db, seller.privy, { car: car.id, price: max + 1 }), 400);
    const price = 1_500_000;
    const { id } = await listCar(db, seller.privy, { car: car.id, price });
    await fails(listCar(db, seller.privy, { car: car.id, price }), 400);
    expect((await listings(db)).some((l) => l.id === id && l.price === price)).toBe(true);
    await fails(buyListed(db, seller.privy, { id }), 400);
    const fees = await balanceOf(db, await systemAccount(db, 'sink:fees'));
    await buyListed(db, buyer.privy, { id });
    await fails(buyListed(db, buyer.privy, { id }), 409);
    const fee = Math.round(price * MARKET.feeShare);
    expect(await balanceOf(db, await walletOf(db, seller.id))).toBe(price - fee);
    expect(await balanceOf(db, await walletOf(db, buyer.id))).toBe(5_000_000 - price);
    expect((await balanceOf(db, await systemAccount(db, 'sink:fees'))) - fees).toBe(fee);
    const owner = await db.query('select account_id from owned_cars where id = $1', [car.id]);
    expect(owner.rows[0]).toMatchObject({ account_id: buyer.id });
    // Not straight back on sale.
    await fails(listCar(db, buyer.privy, { car: car.id, price }), 429);
  });

  it('keeps guests and the rental out, and lets a seller take a listing down', async () => {
    const guest = await person(100, true);
    await fails(listCar(db, guest.privy, { car: 1, price: 1 }), 403);
    const p = await person(carPrice(model('compact')) as number);
    // The rental (given on the first look at the garage) can't be sold.
    const { car } = await buyCar(db, p.privy, {
      model: model('compact'),
      key: `k-${Date.now()}-${n}`,
    });
    const rental = await db.query<{ id: number }>(
      'select id from owned_cars where account_id = $1 and starter',
      [p.id],
    );
    await fails(listCar(db, p.privy, { car: rental.rows[0]?.id, price: 1_000_000 }), 400);
    const { id } = await listCar(db, p.privy, { car: car.id, price: 1_000_000 });
    await withdraw(db, p.privy, { id });
    expect((await listings(db)).some((l) => l.id === id)).toBe(false);
  });
});

describe('market exploits', () => {
  it('sells a car once when many buyers race for it, and a buyer who can’t pay changes nothing', async () => {
    const seller = await person(carPrice(model('suv')) as number);
    const { car } = await buyCar(db, seller.privy, {
      model: model('suv'),
      key: `k-${Date.now()}-${n}`,
    });
    const { id } = await listCar(db, seller.privy, { car: car.id, price: 4_000_000 });
    const broke = await person(100);
    await fails(buyListed(db, broke.privy, { id }), 402);
    const buyers = await Promise.all(Array.from({ length: 6 }, () => person(5_000_000)));
    const results = await Promise.allSettled(buyers.map((b) => buyListed(db, b.privy, { id })));
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    // Only the winner paid; the car is theirs alone.
    let paid = 0;
    for (const b of buyers)
      if ((await balanceOf(db, await walletOf(db, b.id))) < 5_000_000) paid += 1;
    expect(paid).toBe(1);
    const owner = await db.query<{ account_id: string }>(
      'select account_id from owned_cars where id = $1',
      [car.id],
    );
    expect(buyers.map((b) => b.id)).toContain(owner.rows[0]?.account_id);
  });
});
