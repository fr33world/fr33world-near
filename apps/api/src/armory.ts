/**
 * The armoury behind the world server (Phase 8; shared ARMORY): what a player owns (the
 * licence, weapons, rounds), buying at the gun store or the black market (money into the
 * purchases sink and the item into the inventory in one transaction, keyed by the world's id
 * for the purchase), rounds spent, and the kill log.
 */
import { ARMORY, type Arms, CARE, carePrice, levelOf } from '@fr33world/shared';
import { BankError } from './bank.ts';
import { type Db, inTx, type Tx } from './db.ts';
import { spend } from './economy.ts';
import { AccountFrozen, EconomyPaused, InsufficientFunds, LedgerError } from './ledger.ts';

/** A player's gang rank (Phase 9 factions), 0 when not in a gang. */
export type GangRank = (db: Db | Tx, account: string) => Promise<number>;

export async function armsOf(db: Db | Tx, account: string): Promise<Arms> {
  const r = await db.query<{ item: string; count: number }>(
    'select item, count from inventory where account_id = $1 and count > 0',
    [account],
  );
  const arms: Arms = { licence: false, weapons: [], rounds: {}, care: {} };
  for (const { item, count } of r.rows) {
    if (item === 'licence') arms.licence = true;
    const [kind, n] = item.split(':');
    if (kind === 'weapon') arms.weapons.push(Number(n));
    if (kind === 'rounds') arms.rounds[Number(n)] = count;
    if (kind === 'care' && n && arms.care) arms.care[n] = count;
  }
  arms.weapons.sort();
  return arms;
}

async function add(tx: Tx, account: string, item: string, count: number, max = Infinity) {
  await tx.query(
    `insert into inventory (account_id, item, count) values ($1, $2, least($3::int, $4::int))
     on conflict (account_id, item) do update
       set count = least(inventory.count + $3::int, $4::int), updated_at = now()`,
    [account, item, count, Number.isFinite(max) ? max : 2_000_000_000],
  );
}

/**
 * Buys `item` (an ARMORY item id, or 'licence') for `account` with `xp` and gang rank. `key` is
 * the world's id for this purchase.
 */
export async function buyArms(
  db: Db,
  gangRank: GangRank,
  input: { account?: unknown; item?: unknown; key?: unknown; xp?: unknown },
): Promise<{ status: 'posted' | 'duplicate'; arms: Arms; name: string; price: number }> {
  const { account, item, key } = input;
  if (typeof account !== 'string') throw new BankError('account?');
  if (typeof key !== 'string' || !/^[\w:-]{8,96}$/.test(key)) throw new BankError('Bad key.');
  const xp = typeof input.xp === 'number' ? input.xp : 0;
  const licence = item === 'licence';
  const thing = ARMORY.items.find((i) => i.id === item);
  if (!licence && !thing) throw new BankError('Not sold here.');
  const price = licence ? ARMORY.licence.price : (thing?.price ?? 0);
  const name = licence ? 'Pistol licence' : (thing?.name ?? '');
  try {
    return await inTx(db, async (tx) => {
      // One purchase per player at a time, so the limits below can't be raced.
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [account]);
      const has = await armsOf(tx, account);
      const done = await tx.query('select 1 from ledger_transactions where idempotency_key = $1', [
        `arms:${account}:${key}`,
      ]);
      if (!done.rowCount) {
        if (licence) {
          if (has.licence) throw new BankError('You already hold a licence.');
          if (levelOf(xp).level < ARMORY.licence.minLevel)
            throw new BankError(`Licences are for level ${ARMORY.licence.minLevel} and up.`, 403);
        } else if (thing) {
          if (thing.where === 'store' && !has.licence)
            throw new BankError('You need a pistol licence first.', 403);
          if (
            thing.where === 'black_market' &&
            (await gangRank(tx, account)) < ARMORY.blackMarketRank
          )
            throw new BankError('Nobody here sells to strangers.', 403);
          if (!thing.rounds && has.weapons.includes(thing.weapon))
            throw new BankError('You already have one.');
          if (thing.rounds && !has.weapons.includes(thing.weapon))
            throw new BankError('Buy the weapon first.');
          const max = ARMORY.maxRounds[thing.weapon] ?? 0;
          if (thing.rounds && (has.rounds[thing.weapon] ?? 0) + thing.rounds > max)
            throw new BankError(`You can carry at most ${max} rounds.`);
        }
      }
      const paid = await spend(tx, {
        accountId: account,
        sink: 'purchases',
        cents: price,
        key: `arms:${account}:${key}`,
        kind: 'arms',
        memo: { item },
      });
      if (paid.status === 'posted') {
        if (licence) await add(tx, account, 'licence', 1, 1);
        else if (thing?.rounds) await add(tx, account, `rounds:${thing.weapon}`, thing.rounds);
        else if (thing) await add(tx, account, `weapon:${thing.weapon}`, 1, 1);
      }
      return { status: paid.status, arms: await armsOf(tx, account), name, price };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError) throw new BankError('That purchase didn’t go through.', 409);
    throw e;
  }
}

/** Buys a CARE item at the Hospital's counter; `staffed`: an EMS worker is in the building. */
export async function buyCare(
  db: Db,
  input: { account?: unknown; item?: unknown; key?: unknown; staffed?: unknown },
): Promise<{ status: 'posted' | 'duplicate'; arms: Arms; name: string; price: number }> {
  const { account, item, key } = input;
  if (typeof account !== 'string') throw new BankError('account?');
  if (typeof key !== 'string' || !/^[\w:-]{8,96}$/.test(key)) throw new BankError('Bad key.');
  const thing = CARE.items.find((i) => i.id === item);
  if (!thing) throw new BankError('Not sold here.');
  const price = carePrice(thing.price, input.staffed === true);
  try {
    return await inTx(db, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [account]);
      const has = await armsOf(tx, account);
      if ((has.care?.[thing.id] ?? 0) >= CARE.max)
        throw new BankError(`You can carry at most ${CARE.max}.`);
      const paid = await spend(tx, {
        accountId: account,
        sink: 'purchases',
        cents: price,
        key: `care:${account}:${key}`,
        kind: 'care',
        memo: { item: thing.id },
      });
      if (paid.status === 'posted') await add(tx, account, `care:${thing.id}`, 1, CARE.max);
      return { status: paid.status, arms: await armsOf(tx, account), name: thing.name, price };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError) throw new BankError('That purchase didn’t go through.', 409);
    throw e;
  }
}

/** One CARE item used, never below none. */
export async function useCare(db: Db, input: { account?: unknown; item?: unknown }): Promise<Arms> {
  const { account, item } = input;
  if (typeof account !== 'string' || !CARE.items.some((i) => i.id === item))
    throw new BankError('Bad item.');
  await db.query(
    `update inventory set count = greatest(count - 1, 0), updated_at = now()
     where account_id = $1 and item = $2`,
    [account, `care:${String(item)}`],
  );
  return armsOf(db, account);
}

/** Rounds fired since the world last said (`used`: weapon → rounds), never below none. */
export async function spendRounds(
  db: Db,
  input: { account?: unknown; used?: unknown },
): Promise<Arms> {
  const { account, used } = input;
  if (typeof account !== 'string' || typeof used !== 'object' || !used)
    throw new BankError('Bad rounds.');
  for (const [weapon, n] of Object.entries(used as Record<string, unknown>)) {
    if (!/^\d+$/.test(weapon) || typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0)
      continue;
    await db.query(
      `update inventory set count = greatest(0, count - $3), updated_at = now()
       where account_id = $1 and item = $2`,
      [account, `rounds:${weapon}`, n],
    );
  }
  return armsOf(db, account);
}

/** A player went down to another (or to nobody: `killer` null). */
export async function logKill(
  db: Db,
  input: {
    killer?: unknown;
    victim?: unknown;
    killerName?: unknown;
    victimName?: unknown;
    weapon?: unknown;
    x?: unknown;
    z?: unknown;
  },
): Promise<void> {
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : '');
  const id = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : null);
  await db.query(
    `insert into kills (killer, victim, killer_name, victim_name, weapon, x, z)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id(input.killer),
      id(input.victim),
      str(input.killerName),
      str(input.victimName),
      Number(input.weapon) || 0,
      Number(input.x) || 0,
      Number(input.z) || 0,
    ],
  );
}

/** The latest kills, newest first; with `name`, only those a character was in. */
export interface Kill {
  id: number;
  at: string;
  killer_name: string;
  victim_name: string;
  weapon: number;
  x: number;
  z: number;
}

export async function recentKills(db: Db, name?: string): Promise<Kill[]> {
  const r = await db.query<Kill>(
    `select id, at, killer_name, victim_name, weapon, x, z from kills
     where $1::text is null or lower(killer_name) = lower($1) or lower(victim_name) = lower($1)
     order by at desc limit 100`,
    [name ?? null],
  );
  return r.rows;
}
