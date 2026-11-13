/**
 * Players and USDC (Phase 17; D-42 to D-44; owner, 2026-11-13). A player's USDC is in their own
 * NEAR account, the Privy embedded wallet whose key the game never sees: the game prepares a
 * transfer, the player signs it on their device, and the game sends it. The game sells nothing
 * for USDC but `$` top-ups, one way, paid only once the USDC is on chain at the right amount.
 * No function here takes `$` and gives USDC.
 */
import { randomUUID } from 'node:crypto';
import {
  DEALERSHIP,
  formatUsdc,
  GOODS,
  levelOf,
  TEST_USDC,
  TOPUP,
  topupCents,
} from '@fr33world/shared';
import { add, armsOf } from './armory.ts';
import { BankError } from './bank.ts';
import { takeJob } from './business.ts';
import type { Db, Tx } from './db.ts';
import { inTx } from './db.ts';
import { earn, spend } from './economy.ts';
import {
  AccountFrozen,
  balanceOf,
  EconomyPaused,
  InsufficientFunds,
  LedgerError,
  walletOf as walletOfLedger,
} from './ledger.ts';

/** What this module needs of NEAR (packages/chain), so tests can stand in. */
export interface PlayerChain {
  accountOf(short: string): string;
  usdcBalance(account: string): Promise<bigint>;
  /** The token a wallet can hold here and the account's explorer page, for the wallet screen. */
  walletLinks?(account: string): { token: string; explorer: string };
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
  /** Testnet only: the public faucet sends test USDC to the account. Absent: no faucet here. */
  requestTestUsdc?(account: string, micro: number): Promise<{ tx: string }>;
}

export interface UsdcDeps {
  db: Db;
  chain: PlayerChain;
  /** The player's NEAR wallet according to Privy (never the client's word). */
  walletOf: (privyUser: string) => Promise<string | null>;
  /** Between looks for a payment on chain (ms). */
  confirmGapMs?: number;
}

const MAX_CARRY = 5;

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
  return {
    near: me.near,
    micro: Number(await d.chain.usdcBalance(me.near)),
    ...d.chain.walletLinks?.(me.near),
  };
}

/** What Sunny's has and what it costs. */
export async function shelf(db: Db) {
  const r = await db.query<{ good: string; qty: number }>(
    "select good, qty from business_stock where business = 'market'",
  );
  const stock = new Map(r.rows.map((x) => [x.good, x.qty]));
  return GOODS.map((g) => ({
    id: g.id,
    name: g.name,
    heal: g.heal,
    cents: g.cents,
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

/** USDC topped up in the last seven days, pending ones included, so a cap can't be raced. */
async function toppedUp(db: Db | Tx, account: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select coalesce(sum(micro), 0)::bigint as n from usdc_topups
     where account_id = $1 and status in ('pending', 'confirmed')
       and created_at > now() - interval '7 days'`,
    [account],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** What the top-up card shows: the rate and how much is left this week. */
export async function topupStatus(d: UsdcDeps, privyUser: string) {
  const me = await accountOf(d.db, privyUser);
  const used = await toppedUp(d.db, me.id);
  return {
    dollarsPerUsdc: TOPUP.dollarsPerUsdc,
    min: TOPUP.min,
    left: Math.max(0, TOPUP.perWeek - used),
    perWeek: TOPUP.perWeek,
  };
}

/**
 * Starts a top-up: `$` for USDC, one way (shared TOPUP). The USDC goes from the player's own
 * wallet to the dealership's (contracts/business-wallet) with this top-up's id; `$` is paid
 * only once the chain shows it arrived. Full accounts with a character, within the weekly cap.
 */
export async function startTopup(d: UsdcDeps, privyUser: string, body: { micro?: unknown }) {
  const me = await needWallet(d.db, privyUser);
  const micro = body.micro;
  if (typeof micro !== 'number' || !Number.isSafeInteger(micro) || micro < TOPUP.min)
    throw new BankError(`Top up at least ${formatUsdc(TOPUP.min)}.`);
  const c = await d.db.query('select 1 from characters where account_id = $1', [me.id]);
  if (c.rowCount === 0) throw new BankError('Make your character first.', 403);
  await expireTopups(d.db);
  if (BigInt(micro) > (await d.chain.usdcBalance(me.near)))
    throw new BankError('Not enough USDC.', 402);
  const id = `t-${randomUUID().slice(0, 18)}`;
  const cents = topupCents(micro);
  await inTx(d.db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`topup:${me.id}`]);
    const used = await toppedUp(tx, me.id);
    if (used + micro > TOPUP.perWeek)
      throw new BankError(
        `You can top up ${formatUsdc(Math.max(0, TOPUP.perWeek - used))} more this week.`,
        429,
      );
    await tx.query(
      `insert into usdc_topups (id, account_id, near_account, micro, cents, status)
       values ($1, $2, $3, $4, $5, 'pending')`,
      [id, me.id, me.near, micro, cents],
    );
  });
  const prepared = await d.chain.prepare(me.near, {
    method: 'ft_transfer_call',
    receiver: d.chain.accountOf(DEALERSHIP.account),
    amount: micro,
    msg: id,
  });
  return { topup: id, micro, cents, ...prepared };
}

/** The payment on chain, allowing a node a few seconds to catch up with one just sent. */
async function confirmed(d: UsdcDeps, wallet: string, id: string): Promise<string | null> {
  for (let i = 0; i < 5; i += 1) {
    const paid = await d.chain.getSale(wallet, id);
    if (paid !== null) return paid;
    await new Promise((r) => setTimeout(r, d.confirmGapMs ?? 1000));
  }
  return null;
}

/** Sends the signed payment, then pays the `$` only if the chain shows the USDC arrived in full. */
export async function finishTopup(
  d: UsdcDeps,
  privyUser: string,
  body: { topup?: unknown; tx?: unknown; signature?: unknown },
) {
  const me = await needWallet(d.db, privyUser);
  const { topup, tx, signature } = body;
  if (typeof topup !== 'string' || typeof tx !== 'string' || typeof signature !== 'string')
    throw new BankError('Bad request.');
  const r = await d.db.query<{ micro: string; cents: string; status: string }>(
    'select micro, cents, status from usdc_topups where id = $1 and account_id = $2',
    [topup, me.id],
  );
  const row = r.rows[0];
  if (!row) throw new BankError('No such top-up.', 404);
  const wallet = d.chain.accountOf(DEALERSHIP.account);
  let sent: string | null = null;
  if (row.status !== 'confirmed' && !(await d.chain.getSale(wallet, topup)))
    sent = (await d.chain.submit(me.near, tx, signature)).tx;
  const paid = await confirmed(d, wallet, topup);
  if (paid === null || BigInt(paid) !== BigInt(row.micro))
    throw new BankError('The payment didn’t arrive.', 402);
  return inTx(d.db, async (t) => {
    // Paid is paid, even if the top-up had timed out waiting.
    const done = await t.query(
      `update usdc_topups set status = 'confirmed', tx = coalesce($2, tx)
       where id = $1 and status in ('pending', 'expired')`,
      [topup, sent],
    );
    if (done.rowCount)
      await earn(t, {
        accountId: me.id,
        faucet: 'topup',
        cents: Number(row.cents),
        key: `topup:${topup}`,
        memo: { topup, micro: row.micro },
      });
    const wallet$ = await walletOfLedger(t, me.id);
    return { cents: Number(row.cents), balance: await balanceOf(t, wallet$), tx: sent };
  });
}

/** Top-ups never signed stop counting against the week. */
export async function expireTopups(db: Db): Promise<void> {
  await db.query(
    `update usdc_topups set status = 'expired'
     where status = 'pending' and created_at < now() - make_interval(mins => $1)`,
    [TOPUP.minutes],
  );
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

/** Whether a claim would be refused now, and why: the wallet screen asks before offering it. */
async function faucetRefusal(
  db: Db | Tx,
  me: { id: string; near: string },
  held: bigint,
): Promise<string | null> {
  if (held >= BigInt(TEST_USDC.holdingBelow))
    return 'You have enough test USDC for now. Spend some first.';
  const r = await db.query<{ mine: string | null; total: number }>(
    `select max(at) filter (where account_id = $1 or near_account = $2) as mine,
            count(*) filter (where at > now() - interval '1 day')::int as total
     from test_usdc_claims where at > now() - make_interval(hours => $3)`,
    [me.id, me.near, Math.max(TEST_USDC.everyHours, 24)],
  );
  const row = r.rows[0];
  const mine = row?.mine ? new Date(row.mine).getTime() : null;
  if (mine !== null) {
    const next = mine + TEST_USDC.everyHours * 3_600_000;
    if (next > Date.now()) {
      const hours = Math.ceil((next - Date.now()) / 3_600_000);
      return `You can get more in ${hours} hour${hours === 1 ? '' : 's'}.`;
    }
  }
  if ((row?.total ?? 0) >= TEST_USDC.perDay)
    return 'The faucet has given out today’s test USDC. Try tomorrow.';
  return null;
}

/** What the wallet's faucet button shows: whether a claim would go through, and if not why. */
export async function testUsdcStatus(d: UsdcDeps, privyUser: string) {
  if (!d.chain.requestTestUsdc) return { micro: 0, refused: 'Test USDC is only on testnet.' };
  const me = await needWallet(d.db, privyUser);
  const held = await d.chain.usdcBalance(me.near);
  return { micro: TEST_USDC.micro, refused: await faucetRefusal(d.db, me, held) };
}

/**
 * Test USDC from the public testnet faucet, sent straight to the player's own wallet. Full
 * accounts with a character only, within shared TEST_USDC's limits. The claim is written down
 * before the faucet is asked, under a lock, so racing requests can't pass a limit; if the USDC
 * doesn't arrive, the claim is taken back so the player can try again.
 */
export async function claimTestUsdc(d: UsdcDeps, privyUser: string) {
  const faucet = d.chain.requestTestUsdc?.bind(d.chain);
  if (!faucet) throw new BankError('Test USDC is only on testnet.', 404);
  const me = await needWallet(d.db, privyUser);
  const c = await d.db.query('select 1 from characters where account_id = $1', [me.id]);
  if (c.rowCount === 0) throw new BankError('Make your character first.', 403);
  const before = await d.chain.usdcBalance(me.near);
  const claim = await inTx(d.db, async (tx) => {
    // One lock for every claim: the daily total across players must hold too.
    await tx.query("select pg_advisory_xact_lock(hashtext('test-usdc'))");
    const refused = await faucetRefusal(tx, me, before);
    if (refused) throw new BankError(refused, 429);
    const r = await tx.query<{ id: number }>(
      `insert into test_usdc_claims (account_id, near_account, micro) values ($1, $2, $3)
       returning id`,
      [me.id, me.near, TEST_USDC.micro],
    );
    return r.rows[0]!.id;
  });
  try {
    const sent = await faucet(me.near, TEST_USDC.micro);
    let now = before;
    for (let i = 0; i < 5 && now < before + BigInt(TEST_USDC.micro); i += 1) {
      now = await d.chain.usdcBalance(me.near);
      if (now < before + BigInt(TEST_USDC.micro))
        await new Promise((r) => setTimeout(r, d.confirmGapMs ?? 1000));
    }
    if (now < before + BigInt(TEST_USDC.micro)) throw new Error('the test USDC didn’t arrive');
    await d.db.query('update test_usdc_claims set tx = $2 where id = $1', [claim, sent.tx]);
    return { micro: TEST_USDC.micro, tx: sent.tx };
  } catch (e) {
    await d.db.query('delete from test_usdc_claims where id = $1', [claim]);
    console.error('test usdc', e);
    throw new BankError('The faucet didn’t answer. Try again in a minute.', 502);
  }
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
export async function economyView(
  db: Db,
  summary?: (account: string) => Promise<{ balance: string; reserved: string }>,
) {
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
  // Balances are the chain's, read now: the page never shows the game's own opinion of them.
  const withBalances = await Promise.all(
    businesses.rows.map(async (b: { account: string }) => ({
      ...b,
      wallet: summary ? await summary(b.account).catch(() => null) : null,
    })),
  );
  return {
    businesses: withBalances,
    stock: stock.rows,
    orders: orders.rows,
    jobs: jobs.rows,
    decisions: decisions.rows,
  };
}
