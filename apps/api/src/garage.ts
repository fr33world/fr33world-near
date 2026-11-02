/**
 * The cars a player owns (the garage). Every account gets a rental (shared RENTAL: the cheapest
 * car, free for its first days), given the first time its garage is opened (a unique index
 * makes it once, however many ask at the same moment); once it's due back it's gone for good.
 * More are bought at the dealership (shared CARS_FOR_SALE): the price goes from the wallet to
 * the purchases sink and the car into the garage in one database transaction, keyed by the
 * buyer's own request id, so a retry pays once and gets the same car.
 */
import { CAR_MODELS, carPrice, DEALER, RENTAL } from '@fr33world/shared';
import { BankError } from './bank.ts';
import { type Db, inTx, type Tx } from './db.ts';
import { queueMint } from './chain.ts';
import { spend } from './economy.ts';
import {
  AccountFrozen,
  balanceOf,
  EconomyPaused,
  InsufficientFunds,
  LedgerError,
  walletOf,
} from './ledger.ts';

/** The rental: the Compact. */
export const STARTER_MODEL = Math.max(
  0,
  CAR_MODELS.findIndex((m) => m.id === RENTAL.model),
);

export interface OwnedCar {
  id: number;
  model: number;
  colour: number;
  name: string;
  /** Fuel and condition, 0–1, as it was when it last went back to the garage. */
  fuel: number;
  health: number;
  /** A rental: when it's due back (ISO time); null for a car of one's own. */
  expiresAt: string | null;
}

type Row = {
  id: number;
  model: number;
  colour: number;
  fuel: number;
  health: number;
  expires_at: Date | null;
};
/** The garage's columns; cars past their rental are left out everywhere. */
const COLUMNS = 'id, model, colour, fuel, health, expires_at';
const CURRENT = '(expires_at is null or expires_at > now())';

async function giveStarter(db: Db | Tx, accountId: string): Promise<void> {
  await db.query(
    `insert into owned_cars (account_id, model, starter, expires_at)
     values ($1, $2, true, now() + make_interval(days => $3))
     on conflict (account_id) where starter do nothing`,
    [accountId, STARTER_MODEL, RENTAL.days],
  );
}

const named = ({ expires_at, ...c }: Row): OwnedCar => ({
  ...c,
  name: CAR_MODELS[c.model]?.name ?? 'Car',
  expiresAt: expires_at ? new Date(expires_at).toISOString() : null,
});

export async function garageOf(db: Db, accountId: string): Promise<OwnedCar[]> {
  await giveStarter(db, accountId);
  const r = await db.query<Row>(
    `select ${COLUMNS} from owned_cars where account_id = $1 and ${CURRENT} order by id`,
    [accountId],
  );
  return r.rows.map(named);
}

/**
 * Buys a car of `model` (index into CAR_MODELS) for the player logged in as `privyUser`.
 * `key` is the client's id for this purchase.
 */
export async function buyCar(
  db: Db,
  privyUser: string,
  input: { model?: unknown; key?: unknown },
): Promise<{ status: 'posted' | 'duplicate'; car: OwnedCar; balance: number }> {
  const model = input.model;
  const price = typeof model === 'number' && Number.isInteger(model) ? carPrice(model) : null;
  if (price === null || typeof model !== 'number') throw new BankError('That car isn’t for sale.');
  if (typeof input.key !== 'string' || !/^[\w-]{8,64}$/.test(input.key))
    throw new BankError('Bad request id.');
  const r = await db.query<{
    id: string;
    blocked: string | null;
    character: string | null;
    guest: boolean;
  }>(
    `select a.id, a.blocked_reason as blocked, c.name as character, a.is_guest as guest
     from accounts a left join characters c on c.account_id = a.id
     where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me || me.blocked) throw new BankError('Please log in again.', 401);
  if (!me.character) throw new BankError('Make your character first.', 403);
  const key = `car:${me.id}:${input.key}`;

  try {
    return await inTx(db, async (tx) => {
      const wallet = await walletOf(tx, me.id);
      // One purchase per wallet at a time, so the garage's limit can't be raced.
      await tx.query('select id from ledger_accounts where id = $1 for update', [wallet]);
      await giveStarter(tx, me.id);
      const done = await tx.query('select 1 from ledger_transactions where idempotency_key = $1', [
        key,
      ]);
      if (!done.rowCount) {
        const owned = await tx.query<{ n: number }>(
          `select count(*)::int as n from owned_cars where account_id = $1 and ${CURRENT}`,
          [me.id],
        );
        if ((owned.rows[0]?.n ?? 0) >= DEALER.garageMax)
          throw new BankError(`Your garage is full (${DEALER.garageMax} cars).`, 409);
      }
      const paid = await spend(tx, {
        accountId: me.id,
        sink: 'purchases',
        cents: price,
        key,
        kind: 'car',
        memo: { model: CAR_MODELS[model]?.id },
      });
      await tx.query(
        `insert into owned_cars (account_id, model, purchase_tx) values ($1, $2, $3)
         on conflict (purchase_tx) do nothing`,
        [me.id, model, paid.txId],
      );
      const car = await tx.query<Row>(`select ${COLUMNS} from owned_cars where purchase_tx = $1`, [
        paid.txId,
      ]);
      // Its certificate follows (Phase 11): full accounts only; guests' cars stay in the game.
      if (!me.guest) await queueMint(tx, (car.rows[0] as Row).id);
      return {
        status: paid.status,
        car: named(car.rows[0] as Row),
        balance: await balanceOf(tx, wallet),
      };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError) throw new BankError('That purchase didn’t go through.', 409);
    throw e;
  }
}

/** Keeps a car's fuel and condition as it goes back to the garage (the world server). */
export async function saveCondition(
  db: Db,
  input: { account?: unknown; car?: unknown; fuel?: unknown; health?: unknown },
): Promise<boolean> {
  const { account, car, fuel, health } = input;
  const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
  if (
    typeof account !== 'string' ||
    !Number.isSafeInteger(Number(car)) ||
    !unit(fuel) ||
    !unit(health)
  )
    throw new BankError('Bad car condition.');
  const r = await db.query(
    'update owned_cars set fuel = $3, health = $4 where id = $2 and account_id = $1',
    [account, Number(car), fuel, health],
  );
  return (r.rowCount ?? 0) > 0;
}
