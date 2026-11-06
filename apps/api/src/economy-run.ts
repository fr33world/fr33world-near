/**
 * One tick of the economy against the real chain, from a terminal:
 *   node --env-file=../../.env src/economy-run.ts
 * Prints what ran and what the wallets hold. Needs DATABASE_URL and NEAR_OPERATOR_KEY.
 */
import { economyFromEnv } from '@fr33world/chain';
import { BUSINESSES } from '@fr33world/shared';
import { tick } from './business.ts';
import { createDb } from './db.ts';
import { migrate } from './migrate.ts';

const db = createDb(process.env.DATABASE_URL);
await migrate(db);
const chain = economyFromEnv();
const r = await tick({ db, chain, alert: (t) => console.log(`ALERT ${t}`) }, 0);
console.log(r);
for (const b of BUSINESSES) {
  const s = await chain.summary(chain.accountOf(b.account));
  console.log(`${b.name}: ${Number(s.balance) / 1e6} USDC, ${Number(s.reserved) / 1e6} held`);
}
const orders = await db.query(
  'select id, buyer, seller, good, qty, amount, status, tx, last_error from business_orders order by created_at desc limit 6',
);
console.table(orders.rows);
const jobs = await db.query(
  'select id, business, amount, status, last_error from business_jobs order by created_at desc limit 6',
);
console.table(jobs.rows);
await db.end();
