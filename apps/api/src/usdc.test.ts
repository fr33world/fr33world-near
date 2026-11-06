/* eslint-disable @typescript-eslint/require-await -- the stand-in chain answers at once */
import { GOODS, unitPrice, BUSINESSES } from '@fr33world/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { armsOf } from './armory.ts';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import { audit, balanceOf, post, systemAccount, walletOf } from './ledger.ts';
import { inTx } from './db.ts';
import { testDb } from './test-db.ts';
import {
  buyWithDollars,
  expireSales,
  finishSale,
  linkWallet,
  type PlayerChain,
  startSale,
  startSend,
  type UsdcDeps,
  usdcWallet,
} from './usdc.ts';

class FakeChain implements PlayerChain {
  sales = new Map<string, string>();
  balances = new Map<string, bigint>();
  welcomed: string[] = [];
  /** What the next signed payment pays; null: it never arrives. */
  pays: bigint | null | 'full' = 'full';
  prepared = new Map<string, { amount: number; msg?: string }>();
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
  async prepare(_a: string, s: { amount: number; msg?: string }) {
    const tx = `tx-${this.prepared.size}`;
    this.prepared.set(tx, s);
    return { tx, hash: '0xabc' };
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
const market = BUSINESSES.find((b) => b.id === 'market')!;
const meal = GOODS.find((g) => g.id === 'meal')!;
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
    "insert into businesses (id, account, name, markup, target) values ('market', 'soles-market.test', 'Market', 0.3, 60)",
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
  await db.query('truncate business_sales, business_stock');
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

  it('a USDC purchase hands over goods only once the chain shows it paid', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    const s = await startSale(d, p.privy, { good: 'meal' });
    expect(s.micro).toBe(unitPrice(market, meal));
    expect(await stock('meal')).toBe(9);
    await finishSale(d, p.privy, { sale: s.sale, tx: s.tx, signature: 'sig' });
    expect((await armsOf(db, p.id)).care?.meal).toBe(1);
  });

  it('gives nothing for a payment that never arrived', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    const s = await startSale(d, p.privy, { good: 'meal' });
    chain.pays = null;
    await expect(
      finishSale(d, p.privy, { sale: s.sale, tx: s.tx, signature: 'sig' }),
    ).rejects.toBeInstanceOf(BankError);
    expect((await armsOf(db, p.id)).care?.meal).toBeUndefined();
  });

  it('gives nothing for an underpayment', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    const s = await startSale(d, p.privy, { good: 'meal' });
    chain.pays = 1n;
    await expect(
      finishSale(d, p.privy, { sale: s.sale, tx: s.tx, signature: 'sig' }),
    ).rejects.toBeInstanceOf(BankError);
    expect((await armsOf(db, p.id)).care?.meal).toBeUndefined();
  });

  it('confirming twice gives one item', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    const s = await startSale(d, p.privy, { good: 'meal' });
    const body = { sale: s.sale, tx: s.tx, signature: 'sig' };
    await finishSale(d, p.privy, body);
    await finishSale(d, p.privy, body);
    expect((await armsOf(db, p.id)).care?.meal).toBe(1);
  });

  it('someone else cannot claim my sale', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    const other = await player();
    await linkWallet(d, other.privy);
    const s = await startSale(d, p.privy, { good: 'meal' });
    await expect(
      finishSale(d, other.privy, { sale: s.sale, tx: s.tx, signature: 'sig' }),
    ).rejects.toBeInstanceOf(BankError);
  });

  it('an unsigned sale gives its stock back', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    await startSale(d, p.privy, { good: 'meal' });
    await db.query("update business_sales set created_at = now() - interval '1 hour'");
    await expireSales(db);
    expect(await stock('meal')).toBe(10);
  });

  it('a payment that lands after the sale timed out still delivers', async () => {
    const p = await player();
    await linkWallet(d, p.privy);
    const s = await startSale(d, p.privy, { good: 'meal' });
    await db.query("update business_sales set created_at = now() - interval '1 hour'");
    await expireSales(db);
    await finishSale(d, p.privy, { sale: s.sale, tx: s.tx, signature: 'sig' });
    expect((await armsOf(db, p.id)).care?.meal).toBe(1);
    expect(await stock('meal')).toBe(9);
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

describe('$ at the Market', () => {
  it('buys with $, lowers stock, and touches no USDC', async () => {
    const p = await player({ cents: 5_000 });
    const r = await buyWithDollars(db, { account: p.id, good: 'water', key: 'buy-water-1' });
    expect(r.cents).toBe(water.cents);
    expect(await stock('water')).toBe(9);
    expect(await balanceOf(db, await walletOf(db, p.id))).toBe(5_000 - water.cents);
    expect((await audit(db)).total).toBe(0);
  });

  it('refuses a USDC-only good for $', async () => {
    const p = await player({ cents: 5_000 });
    await expect(
      buyWithDollars(db, { account: p.id, good: 'meal', key: 'buy-meal-1' }),
    ).rejects.toThrow('USDC only');
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
