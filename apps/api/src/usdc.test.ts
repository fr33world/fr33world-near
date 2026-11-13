/* eslint-disable @typescript-eslint/require-await -- the stand-in chain answers at once */
import { GOODS, TEST_USDC, TOPUP, topupCents } from '@fr33world/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import { audit, balanceOf, post, systemAccount, walletOf } from './ledger.ts';
import { inTx } from './db.ts';
import { testDb } from './test-db.ts';
import {
  buyWithDollars,
  claimTestUsdc,
  expireTopups,
  finishTopup,
  linkWallet,
  type PlayerChain,
  startTopup,
  startSend,
  testUsdcStatus,
  type UsdcDeps,
  usdcWallet,
} from './usdc.ts';

class FakeChain implements PlayerChain {
  sales = new Map<string, string>();
  balances = new Map<string, bigint>();
  welcomed: string[] = [];
  /** What the next signed payment pays; null: it never arrives. */
  pays: bigint | null | 'full' = 'full';
  prepared = new Map<string, { amount: number; receiver?: string; msg?: string }>();
  accountOf = (s: string) => `${s}.test`;
  async usdcBalance(a: string) {
    return this.balances.get(a) ?? 0n;
  }
  async getSale(_w: string, id: string) {
    return this.sales.get(id) ?? null;
  }
  async welcomePlayer(a: string) {
    this.welcomed.push(a);
  }
  async prepare(_a: string, s: { amount: number; receiver?: string; msg?: string }) {
    const tx = `tx-${this.prepared.size}`;
    this.prepared.set(tx, s);
    return { tx, hash: '0xabc' };
  }
  /** What the faucet does with a request: pay, pay nothing, or fail outright. */
  faucet: 'pay' | 'nothing' | 'fail' = 'pay';
  faucetCalls = 0;
  async requestTestUsdc(a: string, micro: number) {
    this.faucetCalls += 1;
    if (this.faucet === 'fail') throw new Error('rpc down');
    if (this.faucet === 'pay') this.balances.set(a, (this.balances.get(a) ?? 0n) + BigInt(micro));
    return { tx: `faucet-${this.faucetCalls}` };
  }
  async submit(_a: string, tx: string) {
    const p = this.prepared.get(tx)!;
    if (this.pays !== null && p.msg)
      this.sales.set(p.msg, String(this.pays === 'full' ? p.amount : this.pays));
    return { tx: `sent-${tx}` };
  }
}

let db: Db;
let chain: FakeChain;
let d: UsdcDeps;
let n = 0;
const water = GOODS.find((g) => g.id === 'water')!;

async function player(opts: { guest?: boolean; cents?: number } = {}) {
  n += 1;
  const privy = `did:privy:u-${Date.now()}-${n}`;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name, is_guest) values ($1, 'P', $2) returning id",
    [privy, opts.guest ?? false],
  );
  const id = r.rows[0]!.id;
  if (opts.cents)
    await inTx(db, async (tx) =>
      post(tx, {
        kind: 'signup_bonus',
        key: `seed-${privy}`,
        legs: [
          { account: await walletOf(tx, id), amount: opts.cents! },
          { account: await systemAccount(tx, 'faucet:signup'), amount: -opts.cents! },
        ],
      }),
    );
  return { privy, id };
}
let chars = 0;
async function character(id: string) {
  chars += 1;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 25, 0)',
    [id, `Topup Tester${chars}`],
  );
}
const stock = async (g: string) =>
  (
    await db.query<{ qty: number }>(
      "select qty from business_stock where business = 'market' and good = $1",
      [g],
    )
  ).rows[0]!.qty;

beforeAll(async () => {
  db = await testDb('usdc');
  await db.query(
    "insert into businesses (id, account, name, markup, target) values ('market', 'sunnys-grocery.test', 'Market', 0.3, 60)",
  );
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  chain = new FakeChain();
  d = {
    db,
    chain,
    confirmGapMs: 1,
    walletOf: async () => `${'a'.repeat(62)}${String(n).padStart(2, '0')}`,
  };
  await db.query('truncate business_sales, business_stock, usdc_topups');
  for (const g of GOODS)
    await db.query("insert into business_stock (business, good, qty) values ('market', $1, 10)", [
      g.id,
    ]);
});

describe('player USDC', () => {
  it('guests hold no real money', async () => {
    const g = await player({ guest: true });
    await expect(linkWallet(d, g.privy)).rejects.toBeInstanceOf(BankError);
    expect(chain.welcomed).toHaveLength(0);
  });

  it('links the wallet Privy reports, once', async () => {
    const p = await player();
    const { near } = await linkWallet(d, p.privy);
    await linkWallet(d, p.privy);
    expect(chain.welcomed).toEqual([near]);
  });

  it('a top-up pays `$` only once the chain shows the USDC arrived', async () => {
    const p = await player();
    await character(p.id);
    const { near } = await linkWallet(d, p.privy);
    chain.balances.set(near, 10n * 1_000_000n);
    const t = await startTopup(d, p.privy, { micro: 2_000_000 });
    expect(t.cents).toBe(topupCents(2_000_000));
    expect(chain.prepared.get(t.tx)).toMatchObject({ receiver: 'sol-motors.test', msg: t.topup });
    const done = await finishTopup(d, p.privy, { topup: t.topup, tx: t.tx, signature: 'sig' });
    expect(done.balance).toBe(1_000_000);
    expect((await audit(db)).total).toBe(0);
  });

  it('pays nothing for a payment that never arrived, or arrived short', async () => {
    const p = await player();
    await character(p.id);
    const { near } = await linkWallet(d, p.privy);
    chain.balances.set(near, 10n * 1_000_000n);
    const t = await startTopup(d, p.privy, { micro: 2_000_000 });
    chain.pays = null;
    await expect(
      finishTopup(d, p.privy, { topup: t.topup, tx: t.tx, signature: 'sig' }),
    ).rejects.toBeInstanceOf(BankError);
    const u = await startTopup(d, p.privy, { micro: 2_000_000 });
    chain.pays = 1n;
    await expect(
      finishTopup(d, p.privy, { topup: u.topup, tx: u.tx, signature: 'sig' }),
    ).rejects.toBeInstanceOf(BankError);
    expect(await balanceOf(db, await walletOf(db, p.id))).toBe(0);
  });

  it('confirming twice pays once, and nobody else can claim it', async () => {
    const p = await player();
    await character(p.id);
    const { near } = await linkWallet(d, p.privy);
    chain.balances.set(near, 10n * 1_000_000n);
    const other = await player();
    await linkWallet(d, other.privy);
    const t = await startTopup(d, p.privy, { micro: 1_000_000 });
    const body = { topup: t.topup, tx: t.tx, signature: 'sig' };
    await expect(finishTopup(d, other.privy, body)).rejects.toBeInstanceOf(BankError);
    await finishTopup(d, p.privy, body);
    const again = await finishTopup(d, p.privy, body);
    expect(again.balance).toBe(500_000);
  });

  it('keeps to the weekly cap, pending top-ups included', async () => {
    const p = await player();
    await character(p.id);
    const { near } = await linkWallet(d, p.privy);
    chain.balances.set(near, 1_000n * 1_000_000n);
    await startTopup(d, p.privy, { micro: TOPUP.perWeek - 1_000_000 });
    await expect(startTopup(d, p.privy, { micro: 2_000_000 })).rejects.toThrow(/more this week/);
    // An unsigned one stops counting once it expires.
    await db.query("update usdc_topups set created_at = now() - interval '1 hour'");
    await expireTopups(db);
    await startTopup(d, p.privy, { micro: 2_000_000 });
  });

  it('refuses less than the minimum, or more than the wallet holds', async () => {
    const p = await player();
    await character(p.id);
    const { near } = await linkWallet(d, p.privy);
    chain.balances.set(near, 1_000_000n);
    await expect(startTopup(d, p.privy, { micro: 10 })).rejects.toThrow(/at least/);
    await expect(startTopup(d, p.privy, { micro: 2_000_000 })).rejects.toThrow(/Not enough/);
  });

  it('won’t send more than the wallet holds, or to a bad address', async () => {
    const p = await player();
    const { near } = await linkWallet(d, p.privy);
    chain.balances.set(near, 100n);
    await expect(
      startSend(d, p.privy, { to: 'friend.testnet', micro: 101 }),
    ).rejects.toBeInstanceOf(BankError);
    await expect(startSend(d, p.privy, { to: 'BAD ACCOUNT', micro: 1 })).rejects.toBeInstanceOf(
      BankError,
    );
    await expect(startSend(d, p.privy, { to: 'friend.testnet', micro: 100 })).resolves.toBeTruthy();
  });

  it('shows the real balance from the chain', async () => {
    const p = await player();
    const { near } = await linkWallet(d, p.privy);
    chain.balances.set(near, 1_500_000n);
    expect((await usdcWallet(d, p.privy)).micro).toBe(1_500_000);
  });
});

describe('test USDC from the faucet', () => {
  let names = 0;
  async function ready() {
    const p = await player();
    await linkWallet(d, p.privy);
    names += 1;
    await db.query(
      'insert into characters (account_id, name, age, appearance) values ($1, $2, 25, 0)',
      [p.id, `Faucet Tester${names}`],
    );
    const near = (await usdcWallet(d, p.privy)).near!;
    return { ...p, near };
  }
  beforeEach(async () => {
    await db.query('truncate test_usdc_claims');
  });

  it('sends a claim to the player’s own wallet, then not again for a day', async () => {
    const p = await ready();
    expect((await testUsdcStatus(d, p.privy)).refused).toBeNull();
    const got = await claimTestUsdc(d, p.privy);
    expect(got.micro).toBe(TEST_USDC.micro);
    expect(chain.balances.get(p.near)).toBe(BigInt(TEST_USDC.micro));
    // Spent, so the wallet is low again: still once a day.
    chain.balances.set(p.near, 0n);
    await expect(claimTestUsdc(d, p.privy)).rejects.toThrow(/in 24 hours/);
    expect((await testUsdcStatus(d, p.privy)).refused).toMatch(/in 24 hours/);
    await db.query("update test_usdc_claims set at = now() - interval '25 hours'");
    await claimTestUsdc(d, p.privy);
    expect(chain.faucetCalls).toBe(2);
  });

  it('refuses a wallet that already holds enough', async () => {
    const p = await ready();
    chain.balances.set(p.near, BigInt(TEST_USDC.holdingBelow));
    await expect(claimTestUsdc(d, p.privy)).rejects.toThrow(/enough/);
    expect(chain.faucetCalls).toBe(0);
  });

  it('counts the NEAR wallet too, not just the game account', async () => {
    const p = await ready();
    const other = await ready();
    await db.query(
      'insert into test_usdc_claims (account_id, near_account, micro) values ($1, $2, 1)',
      [other.id, p.near],
    );
    await expect(claimTestUsdc(d, p.privy)).rejects.toThrow(/in 24 hours/);
  });

  it('stops for everyone at the daily total', async () => {
    const someone = await ready();
    for (let i = 0; i < TEST_USDC.perDay; i += 1)
      await db.query(
        'insert into test_usdc_claims (account_id, near_account, micro) values ($1, $2, 1)',
        [someone.id, `x${i}.testnet`],
      );
    const p = await ready();
    await expect(claimTestUsdc(d, p.privy)).rejects.toThrow(/today/);
  });

  it('ten claims at once give one', async () => {
    const p = await ready();
    const all = await Promise.allSettled(
      Array.from({ length: 10 }, () => claimTestUsdc(d, p.privy)),
    );
    expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(chain.faucetCalls).toBe(1);
  });

  it('takes the claim back when the USDC never arrives, so the player can try again', async () => {
    const p = await ready();
    chain.faucet = 'nothing';
    await expect(claimTestUsdc(d, p.privy)).rejects.toThrow(/didn’t answer/);
    chain.faucet = 'fail';
    await expect(claimTestUsdc(d, p.privy)).rejects.toThrow(/didn’t answer/);
    chain.faucet = 'pay';
    await claimTestUsdc(d, p.privy);
    expect(chain.balances.get(p.near)).toBe(BigInt(TEST_USDC.micro));
  });

  it('needs a character, and isn’t offered without a faucet', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    await expect(claimTestUsdc(d, p.privy)).rejects.toThrow(/character/);
    const none = { ...d, chain: Object.assign(new FakeChain(), { requestTestUsdc: undefined }) };
    expect((await testUsdcStatus(none, p.privy)).refused).toMatch(/only on testnet/);
    await expect(claimTestUsdc(none, p.privy)).rejects.toThrow(/only on testnet/);
  });
});

describe("$ at Sunny's", () => {
  it('buys with $, lowers stock, and touches no USDC', async () => {
    const p = await player({ cents: 5_000 });
    const r = await buyWithDollars(db, { account: p.id, good: 'water', key: 'buy-water-1' });
    expect(r.cents).toBe(water.cents);
    expect(await stock('water')).toBe(9);
    expect(await balanceOf(db, await walletOf(db, p.id))).toBe(5_000 - water.cents);
    expect((await audit(db)).total).toBe(0);
  });

  it('sells the Hot Meal for $ too: no food is sold for USDC', async () => {
    const p = await player({ cents: 5_000 });
    const r = await buyWithDollars(db, { account: p.id, good: 'meal', key: 'buy-meal-1' });
    expect(r.cents).toBe(2_500);
  });

  it('a failed payment takes no stock', async () => {
    const p = await player({ cents: 1 });
    await expect(
      buyWithDollars(db, { account: p.id, good: 'water', key: 'buy-water-2' }),
    ).rejects.toThrow('Not enough money');
    expect(await stock('water')).toBe(10);
  });

  it('sold out is sold out', async () => {
    const p = await player({ cents: 50_000 });
    await db.query("update business_stock set qty = 0 where good = 'water'");
    await expect(
      buyWithDollars(db, { account: p.id, good: 'water', key: 'buy-water-3' }),
    ).rejects.toThrow('Sold out');
  });
});
