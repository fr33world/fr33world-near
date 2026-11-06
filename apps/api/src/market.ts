/**
 * The car market (Phase 11; shared MARKET): full accounts list their own cars for `$` and buy
 * others'. A sale is one ledger transaction (the price less the fee to the seller, the fee to
 * the fees sink), the car changes owner in the same database transaction,. The newcomer's rental can't be sold.
 */
import { CAR_MODELS, carPrice, DEALER, MARKET } from '@fr33world/shared';
import { BankError } from './bank.ts';
import { type Db, inTx } from './db.ts';
import {
  AccountFrozen,
  EconomyPaused,
  InsufficientFunds,
  LedgerError,
  post,
  systemAccount,
  walletOf,
} from './ledger.ts';

async function fullAccount(db: Db, privyUser: string) {
  const r = await db.query<{ id: string; guest: boolean; name: string | null }>(
    `select a.id, a.is_guest as guest, c.name from accounts a
     left join characters c on c.account_id = a.id where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me) throw new BankError('Please log in again.', 401);
  if (!me.name) throw new BankError('Make your character first.', 403);
  if (me.guest)
    throw new BankError(
      'Guest accounts can’t trade cars. Link an email or social login first.',
      403,
    );
  return me as { id: string; guest: boolean; name: string };
}

/** A model's price bounds on the market (cents), from the dealer's price. */
export function priceBounds(model: number): { min: number; max: number } {
  const base = carPrice(model) ?? 1_000_000;
  return {
    min: Math.round(base * MARKET.floorShare),
    max: Math.round(base * MARKET.ceilingShare),
  };
}

/** Open listings, newest first, with each car's model and the seller's name. */
export async function listings(db: Db) {
  const r = await db.query<{
    id: number;
    car_id: number;
    model: number;
    price: number;
    seller: string;
    listed_at: string;
  }>(
    `select l.id, l.car_id, c.model, l.price, ch.name as seller, l.listed_at
     from car_listings l join owned_cars c on c.id = l.car_id
     join characters ch on ch.account_id = l.seller
     where l.status = 'open' order by l.id desc limit 100`,
  );
  return r.rows.map((l) => ({
    ...l,
    price: Number(l.price),
    name: CAR_MODELS[l.model]?.name ?? 'Car',
  }));
}

/** Lists one of the player's own cars at `price` (cents). */
export async function listCar(
  db: Db,
  privyUser: string,
  input: { car?: unknown; price?: unknown },
): Promise<{ id: number }> {
  const me = await fullAccount(db, privyUser);
  const carId = Number(input.car);
  const price = input.price;
  return inTx(db, async (tx) => {
    const r = await tx.query<{ model: number; starter: boolean; resell_at: Date | null }>(
      `select model, starter, resell_at from owned_cars
       where id = $1 and account_id = $2 and (expires_at is null or expires_at > now()) for update`,
      [carId, me.id],
    );
    const car = r.rows[0];
    if (!car) throw new BankError('That isn’t your car.', 404);
    if (car.starter) throw new BankError('The rental belongs to the Car Dealership.');
    if (car.resell_at && new Date(car.resell_at).getTime() > Date.now())
      throw new BankError('You only just bought it: you can sell it after a day.', 429);
    const { min, max } = priceBounds(car.model);
    if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < min || price > max)
      throw new BankError(`Price it between $${min / 100} and $${max / 100}.`);
    const open = await tx.query<{ n: number }>(
      "select count(*)::int as n from car_listings where seller = $1 and status = 'open'",
      [me.id],
    );
    if ((open.rows[0]?.n ?? 0) >= MARKET.maxListings)
      throw new BankError(`At most ${MARKET.maxListings} cars for sale at once.`);
    const ins = await tx.query<{ id: number }>(
      `insert into car_listings (car_id, seller, price, status) values ($1, $2, $3, 'open')
       on conflict do nothing returning id`,
      [carId, me.id, price],
    );
    const row = ins.rows[0];
    if (!row) throw new BankError('It’s already for sale.');
    return { id: row.id };
  });
}

/** Takes a listing down. */
export async function withdraw(db: Db, privyUser: string, input: { id?: unknown }) {
  const me = await fullAccount(db, privyUser);
  const r = await db.query(
    `update car_listings set status = 'withdrawn', closed_at = now()
     where id = $1 and seller = $2 and status = 'open'`,
    [Number(input.id), me.id],
  );
  if (!r.rowCount) throw new BankError('Not your listing, or not for sale any more.');
  return { withdrawn: true };
}

/** Buys a listed car: paid and moved in one transaction. */
export async function buyListed(
  db: Db,
  privyUser: string,
  input: { id?: unknown },
): Promise<{ car: number; price: number }> {
  const me = await fullAccount(db, privyUser);
  const id = Number(input.id);
  try {
    return await inTx(db, async (tx) => {
      const r = await tx.query<{ car_id: number; seller: string; price: number }>(
        `select car_id, seller, price from car_listings where id = $1 and status = 'open' for update`,
        [id],
      );
      const l = r.rows[0];
      if (!l) throw new BankError('Already sold, or taken down.', 409);
      if (l.seller === me.id) throw new BankError('That’s your own car.');
      const owned = await tx.query<{ n: number }>(
        `select count(*)::int as n from owned_cars where account_id = $1
         and (expires_at is null or expires_at > now())`,
        [me.id],
      );
      if ((owned.rows[0]?.n ?? 0) >= DEALER.garageMax)
        throw new BankError(`Your garage is full (${DEALER.garageMax} cars).`, 409);
      const price = Number(l.price);
      const fee = Math.round(price * MARKET.feeShare);
      await post(tx, {
        kind: 'car_sale',
        key: `sale:${id}`,
        actor: `account:${me.id}`,
        memo: { listing: id, car: l.car_id },
        legs: [
          { account: await walletOf(tx, me.id), amount: -price },
          { account: await walletOf(tx, l.seller), amount: price - fee },
          { account: await systemAccount(tx, 'sink:fees'), amount: fee },
        ],
      });
      await tx.query(
        `update owned_cars set account_id = $2, resell_at = now() + make_interval(hours => $3)
         where id = $1`,
        [l.car_id, me.id, MARKET.resellHours],
      );
      await tx.query(
        "update car_listings set status = 'sold', buyer = $2, closed_at = now() where id = $1",
        [id, me.id],
      );
      return { car: l.car_id, price };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError && !(e instanceof BankError))
      throw new BankError('That sale didn’t go through.', 409);
    throw e;
  }
}
