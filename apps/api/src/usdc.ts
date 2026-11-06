/**
 * Players and USDC (Phase 17; D-42 to D-44). A player's USDC is in their own NEAR account, the
 * Privy embedded wallet whose key the game never sees: the game prepares a transfer, the player
 * signs it on their device, and the game sends it. Goods are handed over only once the sale is
 * on chain at the right amount. No function here takes `$` and gives USDC, or the reverse.
 */
import { randomUUID } from 'node:crypto';
import { BUSINESSES, GOODS, levelOf, unitPrice } from '@fr33world/shared';
import { add, armsOf } from './armory.ts';
import { BankError } from './bank.ts';
import { takeJob } from './business.ts';
import type { Db } from './db.ts';
import { inTx } from './db.ts';
import { spend } from './economy.ts';
import { AccountFrozen, EconomyPaused, InsufficientFunds, LedgerError } from './ledger.ts';

/** What this module needs of NEAR (packages/chain), so tests can stand in. */
export interface PlayerChain {
  accountOf(short: string): string;
  usdcBalance(account: string): Promise<bigint>;
  getSale(wallet: string, id: string): Promise<string | null>;
  welcomePlayer(account: string): Promise<void>;
  prepare(
    account: string,
    spend: {
      method: 'ft_transfer' | 'ft_transfer_call';
      receiver: string;
      amount: number;
      msg?: string;
    },
  ): Promise<{ tx: string; hash: string }>;
  submit(account: string, tx: string, signature: string): Promise<{ tx: string }>;
}

export interface UsdcDeps {
  db: Db;
  chain: PlayerChain;
  /** The player's NEAR wallet according to Privy (never the client's word). */
  walletOf: (privyUser: string) => Promise<string | null>;
}

const MAX_CARRY = 5;
/** How long a USDC sale holds its stock while the player signs. */
const SALE_MINUTES = 10;
const market = BUSINESSES.find((b) => b.id === 'market')!;

async function accountOf(db: Db, privyUser: string) {
  const r = await db.query<{ id: string; is_guest: boolean; near: string | null }>(
    `select a.id, a.is_guest, w.near_account as near from accounts a
     left join near_wallets w on w.account_id = a.id where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me) throw new BankError('Please log in again.', 401);
  return me;
}

async function needWallet(db: Db, privyUser: string) {
  const me = await accountOf(db, privyUser);
  if (!me.near) throw new BankError('Your USDC wallet isn’t set up yet.', 409);
  return { id: me.id, near: me.near };
}

/** Links the player's Privy NEAR wallet to their account, once; guests hold no real money. */
export async function linkWallet(d: UsdcDeps, privyUser: string): Promise<{ near: string }> {
  const me = await accountOf(d.db, privyUser);
  if (me.is_guest) throw new BankError('Make a full account to hold USDC.', 403);
  if (me.near) return { near: me.near };
  const near = await d.walletOf(privyUser);
  if (!near) throw new BankError('Your wallet is still being made. Try again.', 409);
  await d.chain.welcomePlayer(near);
  await d.db.query(
    `insert into near_wallets (account_id, near_account, registered) values ($1, $2, true)
     on conflict (account_id) do nothing`,
    [me.id, near],
  );
  return { near };
}

/** What the wallet card shows. Read from the chain, so it's the real balance. */
export async function usdcWallet(d: UsdcDeps, privyUser: string) {
  const me = await accountOf(d.db, privyUser);
  if (!me.near) return { near: null, micro: 0 };
  return { near: me.near, micro: Number(await d.chain.usdcBalance(me.near)) };
}

/** What the Market has and what it costs. */
export async function shelf(db: Db) {
  const r = await db.query<{ good: string; qty: number }>(
    "select good, qty from business_stock where business = 'market'",
  );
  const stock = new Map(r.rows.map((x) => [x.good, x.qty]));
  return GOODS.map((g) => ({
    id: g.id,
    name: g.name,
    heal: g.heal,
    cents: g.usdcOnly ? null : g.cents,
    micro: unitPrice(market, g),
    stock: stock.get(g.id) ?? 0,
  }));
}

/** A `$` purchase at the till (the world server checks you're there). Stock falls; no USDC moves. */
export async function buyWithDollars(
  db: Db,
  input: { account?: unknown; good?: unknown; key?: unknown },
) {
  const { account, key } = input;
  if (typeof account !== 'string') throw new BankError('account?');
  if (typeof key !== 'string' || !/^[\w:-]{8,96}$/.test(key)) throw new BankError('Bad key.');
  const good = GOODS.find((g) => g.id === input.good);
  if (!good) throw new BankError('Not sold here.');
  if (good.usdcOnly) throw new BankError(`${good.name} is sold for USDC only.`);
  try {
    return await inTx(db, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [account]);
      const has = await armsOf(tx, account);
      if ((has.care?.[good.id] ?? 0) >= MAX_CARRY)
        throw new BankError(`You can carry at most ${MAX_CARRY}.`);
      const taken = await tx.query(
        `update business_stock set qty = qty - 1
         where business = 'market' and good = $1 and qty > 0`,
        [good.id],
      );
      if (taken.rowCount === 0) throw new BankError('Sold out for now.');
      const paid = await spend(tx, {
        accountId: account,
        sink: 'purchases',
        cents: good.cents,
        key: `good:${account}:${key}`,
        kind: 'good',
        memo: { good: good.id },
      });
      if (paid.status === 'posted') {
        await add(tx, account, `care:${good.id}`, 1, MAX_CARRY);
        await tx.query(
          `insert into business_sales (id, business, good, qty, currency, amount, buyer, status)
           values ($1, 'market', $2, 1, 'usd', $3, $4, 'confirmed')`,
          [`d-${randomUUID().slice(0, 18)}`, good.id, good.cents, account],
        );
      }
      return { arms: await armsOf(tx, account), name: good.name, cents: good.cents };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError) throw new BankError('That purchase didn’t go through.', 409);
    throw e;
  }
}

/** Holds one for the player and prepares the USDC payment for them to sign. */
export async function startSale(d: UsdcDeps, privyUser: string, body: { good?: unknown }) {
  const me = await needWallet(d.db, privyUser);
  const good = GOODS.find((g) => g.id === body.good);
  if (!good) throw new BankError('Not sold here.');
  await expireSales(d.db);
  const micro = unitPrice(market, good);
  const id = `s-${randomUUID().slice(0, 18)}`;
  await inTx(d.db, async (tx) => {
    const taken = await tx.query(
      `update business_stock set qty = qty - 1
       where business = 'market' and good = $1 and qty > 0`,
      [good.id],
    );
    if (taken.rowCount === 0) throw new BankError('Sold out for now.');
    await tx.query(
      `insert into business_sales (id, business, good, qty, currency, amount, buyer, status)
       values ($1, 'market', $2, 1, 'usdc', $3, $4, 'pending')`,
      [id, good.id, micro, me.id],
    );
  });
  const prepared = await d.chain.prepare(me.near, {
    method: 'ft_transfer_call',
    receiver: d.chain.accountOf(market.account),
    amount: micro,
    msg: id,
  });
  return { sale: id, micro, ...prepared };
}

/** Sends the signed payment, then hands over the goods only if the chain shows it paid in full. */
export async function finishSale(
  d: UsdcDeps,
  privyUser: string,
  body: { sale?: unknown; tx?: unknown; signature?: unknown },
) {
  const me = await needWallet(d.db, privyUser);
  const { sale, tx, signature } = body;
  if (typeof sale !== 'string' || typeof tx !== 'string' || typeof signature !== 'string')
    throw new BankError('Bad request.');
  const r = await d.db.query<{ good: string; amount: string; status: string }>(
    `select good, amount, status from business_sales
     where id = $1 and buyer = $2 and currency = 'usdc'`,
    [sale, me.id],
  );
  const row = r.rows[0];
  if (!row) throw new BankError('No such sale.', 404);
  const wallet = d.chain.accountOf(market.account);
  let sent: string | null = null;
  if (row.status !== 'confirmed' && !(await d.chain.getSale(wallet, sale)))
    sent = (await d.chain.submit(me.near, tx, signature)).tx;
  const paid = await d.chain.getSale(wallet, sale);
  if (paid === null || BigInt(paid) !== BigInt(row.amount))
    throw new BankError('The payment didn’t arrive.', 402);
  return inTx(d.db, async (t) => {
    // Paid is paid, even if the sale had timed out and its stock gone back.
    const done = await t.query<{ was: string }>(
      `update business_sales s set status = 'confirmed', tx = coalesce($2, s.tx)
       from (select id, status as was from business_sales where id = $1 for update) o
       where s.id = o.id and o.was in ('pending', 'expired') returning o.was`,
      [sale, sent],
    );
    const was = done.rows[0]?.was;
    if (was === 'expired')
      await t.query(
        `update business_stock set qty = greatest(qty - 1, 0)
         where business = 'market' and good = $1`,
        [row.good],
      );
    if (was) await add(t, me.id, `care:${row.good}`, 1, MAX_CARRY);
    return { arms: await armsOf(t, me.id), tx: sent };
  });
}

/** Takes a delivery job. Only full accounts with a wallet, at the right level and age. */
export async function takeDelivery(d: UsdcDeps, privyUser: string, body: { job?: unknown }) {
  const me = await needWallet(d.db, privyUser);
  if (typeof body.job !== 'string') throw new BankError('Which job?');
  const c = await d.db.query<{ xp: string; age: number }>(
    `select xp, extract(epoch from now() - created_at) / 3600 as age from characters
     where account_id = $1`,
    [me.id],
  );
  const row = c.rows[0];
  if (!row) throw new BankError('Make your character first.', 403);
  await takeJob(d.db, {
    account: me.id,
    near: me.near,
    jobId: body.job,
    level: levelOf(Number(row.xp)).level,
    ageHours: Number(row.age),
  });
}

/** Sales never signed give their stock back. */
export async function expireSales(db: Db): Promise<void> {
  await inTx(db, async (tx) => {
    const r = await tx.query<{ good: string }>(
      `update business_sales set status = 'expired'
       where status = 'pending' and created_at < now() - make_interval(mins => $1)
       returning good`,
      [SALE_MINUTES],
    );
    for (const s of r.rows)
      await tx.query(
        "update business_stock set qty = qty + 1 where business = 'market' and good = $1",
        [s.good],
      );
  });
}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Prepares a send from the player's wallet to any NEAR account: their money, their signature. */
export async function startSend(
  d: UsdcDeps,
  privyUser: string,
  body: { to?: unknown; micro?: unknown },
) {
  const me = await needWallet(d.db, privyUser);
  const { to, micro } = body;
  if (typeof to !== 'string' || to.length < 2 || to.length > 64 || !NEAR_ACCOUNT.test(to))
    throw new BankError('That isn’t a NEAR account.');
  if (typeof micro !== 'number' || !Number.isSafeInteger(micro) || micro <= 0)
    throw new BankError('Bad amount.');
  if (BigInt(micro) > (await d.chain.usdcBalance(me.near)))
    throw new BankError('Not enough USDC.', 402);
  return d.chain.prepare(me.near, { method: 'ft_transfer', receiver: to, amount: micro });
}

export async function finishSend(
  d: UsdcDeps,
  privyUser: string,
  body: { tx?: unknown; signature?: unknown },
) {
  const me = await needWallet(d.db, privyUser);
  if (typeof body.tx !== 'string' || typeof body.signature !== 'string')
    throw new BankError('Bad request.');
  return d.chain.submit(me.near, body.tx, body.signature);
}

/** The public view of the economy: no login, so anyone can check it against the chain. */
export async function economyView(db: Db) {
  const [businesses, stock, orders, jobs, decisions] = await Promise.all([
    db.query('select id, account, name, markup, target, last_tick from businesses order by id'),
    db.query('select business, good, qty from business_stock order by business, good'),
    db.query(
      `select id, buyer, seller, good, qty, amount, status, tx, created_at from business_orders
       order by created_at desc limit 30`,
    ),
    db.query(
      `select id, business, amount, status, tx, created_at from business_jobs
       order by (status = 'open') desc, created_at desc limit 30`,
    ),
    db.query(
      `select business, source, summary, details, at from business_decisions
       order by id desc limit 30`,
    ),
  ]);
  return {
    businesses: businesses.rows,
    stock: stock.rows,
    orders: orders.rows,
    jobs: jobs.rows,
    decisions: decisions.rows,
  };
}
