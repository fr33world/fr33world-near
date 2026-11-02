/**
 * A fresh, migrated schema per test file in the test database (TEST_DATABASE_URL, default the
 * local fr33world_test), so test files can run in parallel without touching each other.
 */
import { createDb, type Db } from './db.ts';
import { migrate } from './migrate.ts';

export async function testDb(name: string): Promise<Db> {
  const base = process.env.TEST_DATABASE_URL ?? 'postgres://localhost/fr33world_test';
  const schema = `t_${name}`;
  const admin = createDb(base);
  await admin.query(`drop schema if exists ${schema} cascade; create schema ${schema}`);
  await admin.end();
  const sep = base.includes('?') ? '&' : '?';
  const db = createDb(`${base}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`);
  await migrate(db);
  return db;
}
