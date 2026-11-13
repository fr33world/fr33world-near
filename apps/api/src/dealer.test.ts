/* eslint-disable @typescript-eslint/require-await -- the stand-in chain answers at once */
import { CAR_MODELS, clampBuyback, fairUsdc } from '@fr33world/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CarDeps } from './cars.ts';
import type { Db } from './db.ts';
import { dealerTick, type DealerChain } from './dealer.ts';
import { testDb } from './test-db.ts';

const WALLET = 'sol-motors.test';

/** Just enough of the chain: who holds which car, what's listed, and the wallet's money. */
class FakeChain implements DealerChain {
  owners = new Map<string, string>();
  listed = new Map<string, { seller: string; price: string }>();
  balance = 20_000_000;
  orders = new Map<string, { status: string }>();
  relisted: [string, number][] = [];
  accountOf = (s: string) => `${s}.test`;
  carsAccount = () => 'cars.test';
  async summary() {
    return {
      balance: String(this.balance),
      reserved: '0',
      spent_today: '0',
      per_day: '100000000',
      per_payment: '25000000',
    };
  }
  async sync() {
    return { tx: 'sync' };
  }
  async paySupplier(_w: string, id: string, _to: string, amount: number) {
    const token = id.split(':')[0]!;
    const l = this.listed.get(token);
    if (l && Number(l.price) === amount) {
      this.owners.set(token, WALLET);
      this.listed.delete(token);
      this.balance -= amount;
      this.orders.set(id, { status: 'paid' });
    } else this.orders.set(id, { status: 'failed' });
    return { tx: 'pay' };
  }
  async getOrder(_w: string, id: string) {
    return this.orders.get(id) ?? null;
  }
  async walletListCar(_w: string, token: string, price: number) {
    this.listed.set(token, { seller: WALLET, price: String(price) });
    this.relisted.push([token, price]);
    return { tx: 'list' };
  }
  async carsOf(account: string) {
    return [...this.owners].filter(([, o]) => o === account).map(([token_id]) => ({ token_id }));
  }
  async carListing(token: string) {
    return this.listed.get(token) ?? null;
  }
  // The car module's reads, for its sync after a buyback.
  async carTokens(from: number, limit: number) {
    return [...this.owners]
      .slice(from, from + limit)
      .map(([token_id, owner_id]) => ({ token_id, owner_id }));
  }
  async carListings() {
    return [...this.listed];
  }
}

let db: Db;
let chain: FakeChain;
let n = 0;
const coupe = CAR_MODELS.findIndex((m) => m.id === 'coupe');
const worth = fairUsdc(coupe)!;

beforeAll(async () => {
  db = await testDb('dealer');
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  chain = new FakeChain();
  await db.query("update car_listings set status = 'withdrawn' where status = 'open'");
});

const deps = (ask?: (s: string, u: string) => Promise<string>) => ({
  db,
  chain,
  cars: { db, chain, link: async () => ({ near: 'x' }) } as unknown as CarDeps,
  ask,
  confirmGapMs: 1,
});

/** A player's coupe, minted, listed on chain and in the game for `micro` USDC. */
async function listing(micro: number) {
  const k = (n += 1);
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'S') returning id",
    [`did:privy:dealer-${Date.now()}-${k}`],
  );
  const id = r.rows[0]!.id;
  const near = `seller${k}.test`;
  await db.query('insert into near_wallets (account_id, near_account) values ($1, $2)', [id, near]);
  const car = await db.query<{ id: string }>(
    'insert into owned_cars (account_id, model) values ($1, $2) returning id',
    [id, coupe],
  );
  const carId = Number(car.rows[0]!.id);
  const token = `car-${carId}-t${k}`;
  await db.query(
    "insert into car_chain (car_id, status, wallet, asset) values ($1, 'done', $2, $3)",
    [carId, near, token],
  );
  await db.query(
    "insert into car_listings (car_id, seller, micro, status) values ($1, $2, $3, 'open')",
    [carId, id, micro],
  );
  chain.owners.set(token, near);
  chain.listed.set(token, { seller: near, price: String(micro) });
  return { token, carId };
}

describe('Sol Motors', () => {
  it('buys a car listed far under its worth, and puts it back on sale at a fair price', async () => {
    const cheap = await listing(Math.round(worth * 0.4));
    await listing(Math.round(worth * 0.9));
    const r = await dealerTick(deps());
    expect(r.bought).toBe(cheap.token);
    expect(chain.owners.get(cheap.token)).toBe(WALLET);
    const next = await dealerTick(deps());
    expect(next.listed).toBe(1);
    expect(chain.relisted[0]).toEqual([cheap.token, Math.round(worth / 10_000) * 10_000]);
    const said = await db.query<{ summary: string }>(
      "select summary from business_decisions where business = 'dealer' order by id",
    );
    expect(said.rows.map((x) => x.summary).join(' | ')).toMatch(/Bought a Coupe/);
  });

  it('never buys at or over 60% of worth, or more than its wallet can spare', async () => {
    await listing(Math.round(worth * 0.7));
    chain.balance = 1_000_000;
    await listing(Math.round(worth * 0.3));
    const r = await dealerTick(deps());
    expect(r.bought).toBeNull();
  });

  it('the AI picks within the rules: its price is clamped, and it may buy nothing', async () => {
    const a = await listing(Math.round(worth * 0.4));
    const r = await dealerTick(deps(async () => '{"buy": null, "reason": "Saving up"}'));
    expect(r.bought).toBeNull();
    const s = await dealerTick(deps(async () => '{"buy": 0, "relist": 9, "reason": "Cheap"}'));
    expect(s.bought).toBe(a.token);
    await dealerTick(deps());
    expect(chain.relisted.at(-1)).toEqual([a.token, Math.round((worth * 1.2) / 10_000) * 10_000]);
  });

  it('cuts any answer to a real candidate and a price in bounds', () => {
    expect(clampBuyback({ buy: 7, relist: 0.1 }, 2)).toEqual({ buy: null, relist: 0.9 });
    expect(clampBuyback({ buy: 1, relist: 1.05 }, 2)).toEqual({ buy: 1, relist: 1.05 });
    expect(clampBuyback({ buy: '0' }, 2)).toEqual({ buy: null, relist: 1 });
  });
});
