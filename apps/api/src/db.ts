/**
 * PostgreSQL connection (native locally, no Docker). DATABASE_URL, default the local
 * fr33world_dev database.
 */
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createDb(
  url = process.env.DATABASE_URL ?? 'postgres://localhost/fr33world_dev',
): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // bigint columns (cents, ids) come back as strings by default; amounts stay well inside
  // Number's safe range ($90 trillion), so read them as numbers.
  pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
  return pool;
}

/** Runs `fn` in a transaction: commit on success, roll back on any error. */
export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    const result = await fn(tx);
    await tx.query('commit');
    return result;
  } catch (e) {
    await tx.query('rollback').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}
