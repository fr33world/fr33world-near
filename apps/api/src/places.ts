/**
 * Where each character was last (owner, 2026-10-31): the world server saves it now and then and
 * as they leave, and asks for it when they log in, so a long time away still brings them back.
 */
import { BankError } from './bank.ts';
import type { Db } from './db.ts';

export interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** The most one save carries (the world's player cap and then some). */
const MAX_PLACES = 1000;

const isPlace = (p: Partial<Place>): boolean =>
  [p.x, p.y, p.z, p.yaw].every((n) => typeof n === 'number' && Number.isFinite(n));

export async function placeOf(db: Db, account: unknown): Promise<Place | null> {
  if (typeof account !== 'string') throw new BankError('account?');
  const r = await db.query<{
    last_x: number | null;
    last_y: number;
    last_z: number;
    last_yaw: number;
  }>('select last_x, last_y, last_z, last_yaw from characters where account_id = $1', [account]);
  const row = r.rows[0];
  if (!row || row.last_x === null) return null;
  return { x: row.last_x, y: row.last_y, z: row.last_z, yaw: row.last_yaw };
}

/** Saves many at once: `places` is [{account, x, y, z, yaw}]. */
export async function savePlaces(db: Db, input: { places?: unknown }): Promise<void> {
  const { places } = input;
  if (!Array.isArray(places) || places.length > MAX_PLACES) throw new BankError('Bad places.');
  const good = (places as (Partial<Place> & { account?: unknown })[]).filter(
    (p) => typeof p.account === 'string' && isPlace(p),
  );
  if (good.length === 0) return;
  await db.query(
    `update characters c
     set last_x = v.x, last_y = v.y, last_z = v.z, last_yaw = v.yaw, last_place_at = now()
     from unnest($1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::float8[])
       as v (account, x, y, z, yaw)
     where c.account_id = v.account`,
    [
      good.map((p) => p.account),
      good.map((p) => p.x),
      good.map((p) => p.y),
      good.map((p) => p.z),
      good.map((p) => p.yaw),
    ],
  );
}
