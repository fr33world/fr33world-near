/**
 * Applies apps/api/migrations/*.sql in name order, each once and in its own transaction.
 *   pnpm --filter @fr33world/api migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb, type Db, inTx } from './db.ts';

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(db: Db, log: (line: string) => void = () => {}): Promise<string[]> {
  await db.query(
    'create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())',
  );
  const done = new Set(
    (await db.query<{ id: string }>('select id from schema_migrations')).rows.map((r) => r.id),
  );
  const applied: string[] = [];
  for (const file of readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(file)) continue;
    await inTx(db, async (tx) => {
      await tx.query(readFileSync(DIR + file, 'utf8'));
      await tx.query('insert into schema_migrations (id) values ($1)', [file]);
    });
    applied.push(file);
    log(`applied ${file}`);
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createDb();
  try {
    const applied = await migrate(db, console.log);
    if (applied.length === 0) console.log('up to date');
  } finally {
    await db.end();
  }
}
