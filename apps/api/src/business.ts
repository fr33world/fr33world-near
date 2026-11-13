/**
 * Businesses that run themselves (Phase 17; D-41 to D-45; rules in shared business.ts). A tick
 * restocks by the rules, pays suppliers through the chain queue, posts delivery jobs for
 * players, and sends a van for whatever nobody carried. USDC moves only on chain: this module
 * asks the wallet contracts and never touches the `$` ledger, so no path turns `$` into USDC.
 *
 * Runs on a schedule, not a timer: on free hosting a loop would keep the database awake. A tick
 * covers however long it's been, so the city keeps going with nobody online.
 */
import { randomUUID } from 'node:crypto';
import {
  affordable,
  type Business,
  type BusinessId,
  BUSINESSES,
  DEALERSHIP,
  GOODS,
  jobPay,
  JOB_RULES,
  LOCAL_SUPPLY,
  reorderQuantity,
  unitPrice,
  VAN_AFTER_MS,
} from '@fr33world/shared';
import { advise, type Ask } from './advisor.ts';
import { BankError } from './bank.ts';
import type { Db, Tx } from './db.ts';
import { inTx } from './db.ts';

/** What the economy needs of NEAR (packages/chain NearEconomy), so tests can stand in. */
export interface EconomyChain {
  accountOf(short: string): string;
  summary(wallet: string): Promise<{ balance: string; reserved: string }>;
  getOrder(wallet: string, id: string): Promise<{ status: string } | null>;
  getJob(wallet: string, id: string): Promise<{ status: string } | null>;
  paySupplier(wallet: string, id: string, to: string, amount: number): Promise<{ tx: string }>;
  postJob(wallet: string, id: string, amount: number): Promise<{ tx: string }>;
  assignJob(wallet: string, id: string, worker: string): Promise<{ tx: string }>;
  releaseJob(wallet: string, id: string): Promise<{ tx: string }>;
  cancelJob(wallet: string, id: string): Promise<{ tx: string }>;
}

export interface EconomyDeps {
  db: Db;
  chain: EconomyChain;
  /** Somewhere to say the chain and the database disagree. */
  alert: (text: string) => void;
  now?: () => number;
  /** Between looks for a payment's answer on chain (ms). */
  confirmGapMs?: number;
  /** The AI advisor (advisor.ts); without one, businesses simply keep to their rules. */
  ask?: Ask;
  /** Runs the food chain on USDC (default FOOD_CHAIN_USDC: off); its tests turn it on. */
  foodChain?: boolean;
}

/**
 * The Farm → Wholesale → Sunny's chain paying each other in USDC (D-42). Off since the owner
 * made `$` the only money the game sells for (2026-11-13); the code stays for the record.
 */
export const FOOD_CHAIN_USDC = false;

const byId = (id: string) => BUSINESSES.find((b) => b.id === id) as Business;

/** Live numbers for a business: the shared rules with this city's markup and target. */
async function live(db: Db | Tx): Promise<Business[]> {
  const r = await db.query<{ id: BusinessId; markup: string; target: number }>(
    'select id, markup, target from businesses',
  );
  const rows = new Map(r.rows.map((x) => [x.id, x]));
  return BUSINESSES.map((b) => {
    const row = rows.get(b.id);
    return row ? { ...b, markup: Number(row.markup), target: row.target } : b;
  });
}

/** Creates the businesses and their first stock. They start with goods and no money (D-42). */
export async function seedBusinesses(db: Db, chain: EconomyChain): Promise<void> {
  // Sol Motors holds no stock here: its wallet gets the cut of USDC car sales and the top-ups.
  await db.query(
    `insert into businesses (id, account, name, markup, target) values ($1, $2, $3, 0, 1)
     on conflict (id) do nothing`,
    [DEALERSHIP.id, chain.accountOf(DEALERSHIP.account), DEALERSHIP.name],
  );
  for (const b of BUSINESSES) {
    await db.query(
      `insert into businesses (id, account, name, markup, target) values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [b.id, chain.accountOf(b.account), b.name, b.markup, b.target],
    );
    for (const g of GOODS)
      await db.query(
        `insert into business_stock (business, good, qty) values ($1, $2, $3)
         on conflict (business, good) do nothing`,
        [b.id, g.id, b.target],
      );
  }
}

const decide = (tx: Db | Tx, business: string, summary: string, details: object) =>
  tx.query(
    `insert into business_decisions (business, source, summary, details)
     values ($1, 'rule', $2, $3)`,
    [business, summary, details],
  );

async function stockOf(db: Db | Tx, business: string, good: string): Promise<number> {
  const r = await db.query<{ qty: number }>(
    'select qty from business_stock where business = $1 and good = $2',
    [business, good],
  );
  return r.rows[0]?.qty ?? 0;
}

/** Decides what each business orders, within what its wallet can really pay. */
async function restock(d: EconomyDeps, all: Business[]): Promise<number> {
  let made = 0;
  for (const b of all) {
    if (!b.supplier) continue;
    const seller = all.find((s) => s.id === b.supplier) as Business;
    const wallet = d.chain.accountOf(b.account);
    const s = await d.chain.summary(wallet);
    // Money already promised to orders still in the queue isn't free, whatever the chain says.
    const queued = await d.db.query<{ n: string }>(
      `select coalesce(sum(amount), 0)::bigint as n from business_orders
       where buyer = $1 and status = 'queued'`,
      [b.id],
    );
    const onChain = Number(BigInt(s.balance) - BigInt(s.reserved));
    let free = Math.floor(onChain * JOB_RULES.restockShare) - Number(queued.rows[0]?.n ?? 0);
    for (const good of GOODS) {
      const stock = await stockOf(d.db, b.id, good.id);
      const open = await d.db.query<{ n: number }>(
        `select coalesce(sum(qty), 0)::int as n from business_orders
         where buyer = $1 and good = $2 and status in ('queued', 'paid')`,
        [b.id, good.id],
      );
      const coming = open.rows[0]?.n ?? 0;
      const wanted = reorderQuantity(b, stock + coming);
      if (wanted === 0) continue;
      const price = unitPrice(seller, good, all);
      const available = await stockOf(d.db, seller.id, good.id);
      const qty = Math.min(available, affordable(wanted, price, free, b.perPayment));
      if (qty === 0) {
        await decide(d.db, b.id, `Low on ${good.name} but can't pay for more yet`, {
          stock,
          wanted,
          price,
          free,
        });
        continue;
      }
      const amount = qty * price;
      const id = `o-${randomUUID().slice(0, 18)}`;
      await inTx(d.db, async (tx) => {
        await tx.query(
          'update business_stock set qty = qty - $3 where business = $1 and good = $2',
          [seller.id, good.id, qty],
        );
        await tx.query(
          `insert into business_orders (id, buyer, seller, good, qty, amount, status)
           values ($1, $2, $3, $4, $5, $6, 'queued')`,
          [id, b.id, seller.id, good.id, qty, amount],
        );
        await decide(tx, b.id, `Ordered ${qty} ${good.name} from ${seller.name}`, {
          stock,
          coming,
          price,
          amount,
          free,
        });
      });
      free -= amount;
      made += 1;
    }
  }
  return made;
}

/** The farm grows its own, and the local supplier keeps `$` goods on Sunny's shelves. */
async function replenish(db: Db, all: Business[]): Promise<void> {
  const farm = all.find((b) => !b.supplier);
  if (farm)
    await db.query('update business_stock set qty = $2 where business = $1', [
      farm.id,
      farm.target,
    ]);
  const market = all.find((b) => b.id === 'market') as Business;
  for (const g of GOODS)
    await db.query(
      `update business_stock set qty = least(greatest(qty, $3), qty + $4)
       where business = $1 and good = $2`,
      [market.id, g.id, Math.floor(market.target * LOCAL_SUPPLY.upTo), LOCAL_SUPPLY.perTick],
    );
}

function backoff(attempts: number): number {
  return Math.min(6 * 3600, 60 * 2 ** attempts);
}

const failed = (db: Db, table: string, id: string, attempts: number, e: unknown) =>
  db.query(
    `update ${table} set attempts = attempts + 1, last_error = $2, updated_at = now(),
       next_at = now() + make_interval(secs => $3) where id = $1`,
    [id, (e instanceof Error ? e.message : String(e)).slice(0, 300), backoff(attempts)],
  );

/** Waits a few seconds for the token contract's answer to reach the wallet. */
async function answered(d: EconomyDeps, wallet: string, id: string) {
  let chain = await d.chain.getOrder(wallet, id);
  for (let i = 0; i < 5 && chain?.status === 'pending'; i += 1) {
    await new Promise((r) => setTimeout(r, d.confirmGapMs ?? 1500));
    chain = await d.chain.getOrder(wallet, id);
  }
  return chain;
}

/** Pays queued orders. Asks the chain first, so a retry after a timeout never pays twice. */
async function payOrders(d: EconomyDeps, all: Business[]): Promise<number> {
  const due = await d.db.query<{
    id: string;
    buyer: string;
    seller: string;
    amount: number;
    attempts: number;
  }>(
    `select id, buyer, seller, amount, attempts from business_orders
     where status = 'queued' and next_at <= now() order by next_at limit 10`,
  );
  let paid = 0;
  for (const o of due.rows) {
    const buyer = all.find((b) => b.id === o.buyer) as Business;
    const seller = all.find((b) => b.id === o.seller) as Business;
    const wallet = d.chain.accountOf(buyer.account);
    try {
      let chain = await d.chain.getOrder(wallet, o.id);
      let tx: string | null = null;
      if (!chain) {
        tx = (
          await d.chain.paySupplier(
            wallet,
            o.id,
            d.chain.accountOf(seller.account),
            Number(o.amount),
          )
        ).tx;
        chain = await answered(d, wallet, o.id);
      } else if (chain.status === 'pending') chain = await answered(d, wallet, o.id);
      if (chain?.status === 'paid') {
        await d.db.query(
          `update business_orders set status = 'paid', tx = coalesce($2, tx), last_error = null,
             updated_at = now() where id = $1`,
          [o.id, tx],
        );
        paid += 1;
      } else if (chain?.status === 'failed') await refuse(d.db, o.id, 'the payment failed');
      else throw new Error(`order ${chain?.status ?? 'missing'} on chain`);
    } catch (e) {
      if (o.attempts + 1 >= JOB_RULES.maxAttempts) {
        await refuse(d.db, o.id, e instanceof Error ? e.message.slice(0, 300) : 'gave up');
        d.alert(`Order ${o.id} gave up after ${o.attempts + 1} tries`);
      } else await failed(d.db, 'business_orders', o.id, o.attempts, e);
    }
  }
  return paid;
}

/** An order that can't be paid: its goods go back to the seller. */
async function refuse(db: Db, id: string, why: string) {
  await inTx(db, async (tx) => {
    const r = await tx.query<{ seller: string; good: string; qty: number }>(
      `update business_orders set status = 'failed', last_error = $2, updated_at = now()
       where id = $1 and status = 'queued' returning seller, good, qty`,
      [id, why],
    );
    const o = r.rows[0];
    if (o)
      await tx.query('update business_stock set qty = qty + $3 where business = $1 and good = $2', [
        o.seller,
        o.good,
        o.qty,
      ]);
  });
}

/** Offers paid orders to players as delivery jobs, while the wallet has money to spare. */
async function offerJobs(d: EconomyDeps, all: Business[]): Promise<number> {
  const waiting = await d.db.query<{ id: string; buyer: string; amount: number }>(
    `select o.id, o.buyer, o.amount from business_orders o
     where o.status = 'paid' and not exists (select 1 from business_jobs j where j.order_id = o.id)
     order by o.created_at limit 10`,
  );
  let offered = 0;
  for (const o of waiting.rows) {
    const b = all.find((x) => x.id === o.buyer) as Business;
    const open = await d.db.query<{ n: number }>(
      `select count(*)::int as n from business_jobs
       where business = $1 and status in ('queued', 'open')`,
      [b.id],
    );
    if ((open.rows[0]?.n ?? 0) >= JOB_RULES.maxOpen) continue;
    const s = await d.chain.summary(d.chain.accountOf(b.account));
    const free = Number(BigInt(s.balance) - BigInt(s.reserved));
    const pay = jobPay(Number(o.amount));
    if (free * JOB_RULES.keepFree < pay) continue;
    await d.db.query(
      `insert into business_jobs (id, business, order_id, amount, status)
       values ($1, $2, $3, $4, 'queued')`,
      [`j-${randomUUID().slice(0, 18)}`, b.id, o.id, pay],
    );
    offered += 1;
  }
  return offered;
}

/** Sends job steps to the chain, each checked against the chain's state first. */
async function runJobs(d: EconomyDeps, all: Business[]): Promise<void> {
  const due = await d.db.query<{
    id: string;
    business: string;
    amount: number;
    status: string;
    worker_near: string | null;
    attempts: number;
  }>(
    `select id, business, amount, status, worker_near, attempts from business_jobs
     where status in ('queued', 'assigning', 'releasing', 'cancelling') and next_at <= now()
     order by next_at limit 10`,
  );
  for (const j of due.rows) {
    const b = all.find((x) => x.id === j.business) as Business;
    const wallet = d.chain.accountOf(b.account);
    try {
      let chain = await d.chain.getJob(wallet, j.id);
      let tx: string | null = null;
      let next: string;
      if (j.status === 'queued') {
        if (!chain) tx = (await d.chain.postJob(wallet, j.id, Number(j.amount))).tx;
        next = 'open';
      } else if (j.status === 'assigning') {
        if (chain?.status === 'open')
          tx = (await d.chain.assignJob(wallet, j.id, j.worker_near as string)).tx;
        next = 'assigned';
      } else if (j.status === 'releasing') {
        if (chain?.status === 'assigned') tx = (await d.chain.releaseJob(wallet, j.id)).tx;
        chain = await d.chain.getJob(wallet, j.id);
        if (chain?.status !== 'paid') throw new Error(`job ${chain?.status ?? 'missing'} on chain`);
        next = 'paid';
      } else {
        if (chain && chain.status !== 'cancelled') tx = (await d.chain.cancelJob(wallet, j.id)).tx;
        next = 'cancelled';
      }
      await d.db.query(
        `update business_jobs set status = $2, tx = coalesce($3, tx), last_error = null,
           updated_at = now() where id = $1`,
        [j.id, next, tx],
      );
    } catch (e) {
      await failed(d.db, 'business_jobs', j.id, j.attempts, e);
    }
  }
}

async function arrive(tx: Tx, orderId: string): Promise<void> {
  const r = await tx.query<{ buyer: string; good: string; qty: number }>(
    `update business_orders set status = 'delivered', updated_at = now()
     where id = $1 and status = 'paid' returning buyer, good, qty`,
    [orderId],
  );
  const o = r.rows[0];
  if (o)
    await tx.query('update business_stock set qty = qty + $3 where business = $1 and good = $2', [
      o.buyer,
      o.good,
      o.qty,
    ]);
}

/** Orders nobody carried in time come by van, and any job left open is given up. */
async function vans(d: EconomyDeps): Promise<number> {
  const now = d.now?.() ?? Date.now();
  const late = await d.db.query<{ id: string; job: string | null; job_status: string | null }>(
    `select o.id, j.id as job, j.status as job_status from business_orders o
     left join business_jobs j on j.order_id = o.id
     where o.status = 'paid' and o.updated_at <= $1
       and (j.id is null or j.status in ('queued', 'open', 'cancelled'))`,
    [new Date(now - VAN_AFTER_MS)],
  );
  for (const o of late.rows)
    await inTx(d.db, async (tx) => {
      await arrive(tx, o.id);
      if (o.job && o.job_status !== 'cancelled')
        await tx.query(
          `update business_jobs set status = 'cancelling', next_at = now(), updated_at = now()
           where id = $1`,
          [o.job],
        );
    });
  // A job taken and left: its money is freed, and the goods come by van.
  const left = await d.db.query<{ id: string; order_id: string }>(
    `select id, order_id from business_jobs where status = 'assigned' and updated_at <= $1`,
    [new Date(now - JOB_RULES.takenForMs)],
  );
  for (const j of left.rows)
    await inTx(d.db, async (tx) => {
      await arrive(tx, j.order_id);
      await tx.query(
        `update business_jobs set status = 'cancelling', next_at = now(), updated_at = now()
         where id = $1`,
        [j.id],
      );
    });
  return late.rows.length + left.rows.length;
}

/** Checks the database's view of each wallet against the chain, and flags any difference. */
export async function reconcile(d: EconomyDeps): Promise<number> {
  let bad = 0;
  const all = await live(d.db);
  for (const b of all) {
    const wallet = d.chain.accountOf(b.account);
    const held = await d.db.query<{ n: string }>(
      `select coalesce(sum(amount), 0)::bigint as n from business_jobs
       where business = $1 and status in ('open', 'assigning', 'assigned', 'cancelling')`,
      [b.id],
    );
    const s = await d.chain.summary(wallet);
    const expected = BigInt(held.rows[0]?.n ?? 0);
    if (BigInt(s.reserved) !== expected) {
      bad += 1;
      d.alert(`${b.name}: chain holds ${s.reserved}, the game expects ${expected}`);
    }
  }
  return bad;
}

/** Asks the advisor once a day at most: it's for slow changes, not routine work. */
async function adviseDaily(d: EconomyDeps): Promise<void> {
  if (!d.ask) return;
  const r = await d.db.query(
    `select 1 from business_decisions
     where source = 'ai' and at > now() - interval '1 day' limit 1`,
  );
  if (r.rowCount) return;
  await advise(d.db, d.ask, async (b) => {
    const s = await d.chain.summary(d.chain.accountOf(b.account));
    return Number(BigInt(s.balance) - BigInt(s.reserved));
  });
}

export interface TickResult {
  ran: boolean;
  ordered: number;
  paid: number;
  offered: number;
  vans: number;
  mismatches: number;
}

const SKIPPED: TickResult = { ran: false, ordered: 0, paid: 0, offered: 0, vans: 0, mismatches: 0 };

/** One round of the economy. Safe to trigger from anywhere: it runs at most every `minGapS`. */
export async function tick(d: EconomyDeps, minGapS = 600): Promise<TickResult> {
  const claimed = await d.db.query(
    `update economy_ticks set last_at = now()
     where last_at is null or last_at <= now() - make_interval(secs => $1) returning id`,
    [minGapS],
  );
  if (claimed.rowCount === 0) return SKIPPED;
  await seedBusinesses(d.db, d.chain);
  const all = await live(d.db);
  await replenish(d.db, all);
  // Food is sold for `$` only now (owner, 2026-11-13), so the food chain orders and offers
  // nothing in USDC: what was already under way is finished, and its held money freed.
  await runJobs(d, all);
  const late = await vans(d);
  const food = d.foodChain ?? FOOD_CHAIN_USDC;
  const ordered = food ? await restock(d, all) : 0;
  const paid = await payOrders(d, all);
  const offered = food ? await offerJobs(d, all) : 0;
  await runJobs(d, all);
  const mismatches = await reconcile(d);
  if (food) await adviseDaily(d);
  await d.db.query('update businesses set last_tick = now()');
  return { ran: true, ordered, paid, offered, vans: late, mismatches };
}

/** A job for the player: fixed to their NEAR account on chain, one at a time, within the caps. */
export async function takeJob(
  db: Db,
  input: { account: string; near: string; jobId: string; level: number; ageHours: number },
): Promise<void> {
  if (input.level < JOB_RULES.minLevel || input.ageHours < JOB_RULES.minCharacterAgeHours)
    throw new EconomyError(
      `USDC jobs open at level ${JOB_RULES.minLevel}, a day after making your character.`,
    );
  const done = await db.query<{ n: number }>(
    `select count(*)::int as n from business_jobs
     where worker = $1 and status in ('assigning', 'assigned', 'releasing', 'paid')
       and updated_at > now() - interval '1 day'`,
    [input.account],
  );
  if ((done.rows[0]?.n ?? 0) >= JOB_RULES.perPlayerPerDay)
    throw new EconomyError('That is all the USDC jobs for today.');
  const r = await db
    .query(
      `update business_jobs set status = 'assigning', worker = $2, worker_near = $3,
         next_at = now(), updated_at = now() where id = $1 and status = 'open'`,
      [input.jobId, input.account, input.near],
    )
    .catch((e: { constraint?: string }) => {
      if (e.constraint === 'one_job_per_worker')
        throw new EconomyError('Finish the job you have first.');
      throw e;
    });
  if (r.rowCount === 0) throw new EconomyError('Someone else took that job.');
}

/** The server saw the delivery: the goods arrive and the pay is queued. One job at a time. */
export async function finishJob(db: Db, input: { account: string }): Promise<void> {
  await inTx(db, async (tx) => {
    const r = await tx.query<{ order_id: string }>(
      `update business_jobs set status = 'releasing', next_at = now(), updated_at = now()
       where worker = $1 and status = 'assigned' returning order_id`,
      [input.account],
    );
    const row = r.rows[0];
    if (!row) throw new EconomyError("Take a delivery job at Sunny's first.");
    await arrive(tx, row.order_id);
  });
}

/** Sends waiting job steps at once, so a player isn't left until the next tick for their pay. */
export async function settleJobs(d: EconomyDeps): Promise<void> {
  await runJobs(d, await live(d.db));
}

export class EconomyError extends BankError {
  constructor(message: string, status = 409) {
    super(message, status);
  }
}

export { byId };
