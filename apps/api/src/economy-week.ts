/**
 * A week of the economy in about a minute: `pnpm --filter @fr33world/api economy:week`.
 *
 * The real engine (business.ts) and database rules, with the chain simulated in memory so seven
 * days don't take seven days. Shoppers pay USDC for goods, businesses restock and pay each other,
 * and drivers are paid for deliveries. At the end it proves no USDC was created: everything
 * held or paid out adds up to exactly what shoppers put in. Needs `pnpm db:start`.
 * For the same loop on the real chain, see packages/chain smoke.ts.
 */
import { BUSINESSES, formatUsdc, GOODS, unitPrice } from '@fr33world/shared';
import { finishJob, seedBusinesses, takeJob, tick } from './business.ts';
import { SimChain } from './sim-chain.ts';
import { testDb } from './test-db.ts';

const DAYS = 7;
const TICKS_PER_DAY = 8;

/** A small seeded random source, so every run tells the same story. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = await testDb('economy_week');
const chain = new SimChain();
const rand = random(7);
const market = BUSINESSES.find((b) => b.id === 'market')!;
const wallet = chain.accountOf(market.account);
await seedBusinesses(db, chain);
await db.query('update economy_ticks set last_at = null');

const drivers: string[] = [];
for (let i = 0; i < 4; i += 1) {
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'Driver') returning id",
    [`did:privy:week-${Date.now()}-${i}`],
  );
  drivers.push(r.rows[0]!.id);
}

let spent = 0;
const days: Record<string, string | number>[] = [];
for (let day = 1; day <= DAYS; day += 1) {
  let sold = 0;
  // Weekends are busier: demand moves and the businesses have to follow it.
  const shoppers = day >= 6 ? 12 : 5;
  for (let t = 0; t < TICKS_PER_DAY; t += 1) {
    for (let s = 0; s < shoppers; s += 1) {
      if (rand() > 0.5) continue;
      const good = GOODS[Math.floor(rand() * GOODS.length)]!;
      const took = await db.query(
        `update business_stock set qty = qty - 1
         where business = 'market' and good = $1 and qty > 0`,
        [good.id],
      );
      if (took.rowCount === 0) continue;
      const price = unitPrice(market, good);
      chain.fund(wallet, price);
      spent += price;
      sold += 1;
    }
    await tick({ db, chain, alert: (a) => console.log(`ALERT ${a}`), confirmGapMs: 1 }, 0);
    const open = await db.query<{ id: string }>(
      "select id from business_jobs where status = 'open' order by created_at limit 2",
    );
    for (const [i, job] of open.rows.entries()) {
      const driver = drivers[(day + t + i) % drivers.length]!;
      await db.query(
        "update business_jobs set worker = null where worker = $1 and status = 'paid'",
        [driver],
      );
      await takeJob(db, {
        account: driver,
        near: `driver-${drivers.indexOf(driver)}.test`,
        jobId: job.id,
        level: 9,
        ageHours: 99,
      }).catch(() => {});
    }
    await tick({ db, chain, alert: () => {}, confirmGapMs: 1 }, 0);
    for (const driver of drivers) await finishJob(db, { account: driver }).catch(() => {});
    await tick({ db, chain, alert: () => {}, confirmGapMs: 1 }, 0);
    // A day's jobs and orders age, as they would between real ticks.
    await db.query("update business_orders set updated_at = updated_at - interval '3 hours'");
  }
  const held = (id: string) => chain.wallets.get(id)?.balance ?? 0;
  const paid = [...chain.paidTo.values()].reduce((a, b) => a + b, 0);
  days.push({
    day,
    'goods sold': sold,
    market: formatUsdc(held(wallet)),
    wholesale: formatUsdc(held(chain.accountOf('harbor-wholesale'))),
    farm: formatUsdc(held(chain.accountOf('sol-farm'))),
    'paid to drivers': formatUsdc(paid),
  });
}
console.table(days);

const held = [...chain.wallets.values()].reduce((a, w) => a + w.balance, 0);
const paid = [...chain.paidTo.values()].reduce((a, b) => a + b, 0);
console.log(`Shoppers put in      ${formatUsdc(spent)}`);
console.log(`Held by businesses   ${formatUsdc(held)}`);
console.log(`Paid to drivers      ${formatUsdc(paid)}`);
const ok = held + paid === spent;
console.log(ok ? 'No USDC created: it all adds up.' : 'MISMATCH: USDC was created or lost.');
const decisions = await db.query<{ summary: string }>(
  'select summary from business_decisions order by id desc limit 3',
);
console.log('Latest decisions:', decisions.rows.map((d) => d.summary).join(' | '));
await db.end();
process.exit(ok ? 0 : 1);
