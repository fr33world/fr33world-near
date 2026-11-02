import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.ts';
import { placeOf, savePlaces } from './places.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await testDb('places');
});
afterAll(async () => {
  await db.end();
});

async function person() {
  n += 1;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'P') returning id",
    [`did:privy:place-${Date.now()}-${n}`],
  );
  const id = (r.rows[0] as { id: string }).id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 31, 0)',
    [id, `Place Person${Date.now()}${n}`],
  );
  return id;
}

describe('last place', () => {
  it('has none for a new character', async () => {
    expect(await placeOf(db, await person())).toBeNull();
  });

  it('keeps the latest of several saved at once', async () => {
    const a = await person();
    const b = await person();
    await savePlaces(db, {
      places: [
        { account: a, x: 10.5, y: 0.2, z: -40, yaw: 1 },
        { account: b, x: 4013, y: 0, z: 4004, yaw: 0 },
      ],
    });
    await savePlaces(db, { places: [{ account: a, x: 11, y: 0.2, z: -41, yaw: 2 }] });
    expect(await placeOf(db, a)).toEqual({ x: 11, y: 0.2, z: -41, yaw: 2 });
    expect(await placeOf(db, b)).toEqual({ x: 4013, y: 0, z: 4004, yaw: 0 });
  });

  it('skips a bad entry without losing the rest', async () => {
    const a = await person();
    const b = await person();
    await savePlaces(db, {
      places: [
        { account: a, x: Number.NaN, y: 0, z: 0, yaw: 0 },
        { account: b, x: 1, y: 2, z: 3, yaw: 0 },
      ],
    });
    expect(await placeOf(db, a)).toBeNull();
    expect(await placeOf(db, b)).toEqual({ x: 1, y: 2, z: 3, yaw: 0 });
  });
});
