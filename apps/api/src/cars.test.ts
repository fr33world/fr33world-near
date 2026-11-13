/* eslint-disable @typescript-eslint/require-await -- the stand-in chain answers at once */
import { carPrice, CAR_MODELS, USDC } from '@fr33world/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BankError } from './bank.ts';
import {
  buyForUsdc,
  type CarCall,
  type CarChain,
  type CarDeps,
  type ChainListing,
  type StepResult,
  dollarSaleToken,
  listOnChain,
  queueMints,
  runMints,
  sendCar,
  syncCars,
  unlistOnChain,
} from './cars.ts';
import type { Db } from './db.ts';
import { buyCar, garageOf } from './garage.ts';
import { audit, balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { buyListed, listCar, listings, priceBounds } from './market.ts';
import { testDb } from './test-db.ts';

/** The cars contract, as far as the game can tell: owners, listings, `$` offers and locks. */
class FakeCars implements CarChain {
  owners = new Map<string, string>();
  listed = new Map<string, ChainListing>();
  offers = new Set<string>();
  locked = new Map<string, number>();
  usdc = new Map<string, bigint>();
  minted: string[] = [];
  handed: [string, string][] = [];
  /** Fails the next n mints, or every handover. */
  failMints = 0;
  failHandover = false;
  private pending = new Map<string, { from: string; run: () => void }>();
  private n = 0;

  carsAccount = () => 'cars.test';
  async mintCar(token: string, owner: string) {
    if (this.failMints > 0) {
      this.failMints -= 1;
      throw new Error('rpc down');
    }
    if (this.owners.has(token)) throw new Error('token_id must be unique');
    this.owners.set(token, owner);
    this.minted.push(token);
    return { tx: `mint-${token}` };
  }
  async gameTransfer(token: string, to: string) {
    if (this.failHandover || !this.offers.has(token)) throw new Error('not offered to the game');
    this.move(token, to);
    this.handed.push([token, to]);
    return { tx: 'handover' };
  }
  private move(token: string, to: string) {
    this.owners.set(token, to);
    this.listed.delete(token);
    this.offers.delete(token);
  }
  async carToken(token: string) {
    const owner = this.owners.get(token);
    return owner ? { token_id: token, owner_id: owner } : null;
  }
  async carTokens(from: number, limit: number) {
    return [...this.owners]
      .slice(from, from + limit)
      .map(([token_id, owner_id]) => ({ token_id, owner_id }));
  }
  async carListing(token: string) {
    return this.listed.get(token) ?? null;
  }
  async carListings() {
    return [...this.listed];
  }
  async isOffered(token: string) {
    return this.offers.has(token);
  }
  async carLockedUntil(token: string) {
    return this.locked.get(token) ?? 0;
  }
  async ensureGas() {}
  async usdcBalance(a: string) {
    return this.usdc.get(a) ?? 0n;
  }
  /** What signing does: the call runs as `from`, with the contract's own checks. */
  private queue(from: string, run: () => void) {
    const tx = `tx-${(this.n += 1)}`;
    this.pending.set(tx, { from, run });
    return { tx, hash: `0x${this.n}` };
  }
  async prepareCar(from: string, c: CarCall) {
    return this.queue(from, () => {
      const owner = this.owners.get(c.tokenId);
      if (owner !== from) throw new Error('not your car');
      if (c.method === 'list_car')
        this.listed.set(c.tokenId, { seller: from, price: String(c.price) });
      else if (c.method === 'delist_car') this.listed.delete(c.tokenId);
      else if (c.method === 'offer_to_game') this.offers.add(c.tokenId);
      else if (c.method === 'withdraw_offer') this.offers.delete(c.tokenId);
      else if (c.method === 'nft_transfer') this.move(c.tokenId, c.receiver);
    });
  }
  async prepare(from: string, s: { receiver: string; amount: number; msg: string }) {
    return this.queue(from, () => {
      const l = this.listed.get(s.msg);
      if (!l || Number(l.price) !== s.amount || l.seller === from) return; // refunded
      this.usdc.set(from, (this.usdc.get(from) ?? 0n) - BigInt(s.amount));
      this.usdc.set(l.seller, (this.usdc.get(l.seller) ?? 0n) + (BigInt(s.amount) * 95n) / 100n);
      this.move(s.msg, from);
    });
  }
  async submit(from: string, tx: string) {
    const p = this.pending.get(tx);
    if (!p || p.from !== from) throw new Error('not this player’s transaction');
    this.pending.delete(tx);
    p.run();
    return { tx: `sent-${tx}` };
  }
}

let db: Db;
let chain: FakeCars;
let d: CarDeps;
let n = 0;

beforeAll(async () => {
  db = await testDb('cars');
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => {
  chain = new FakeCars();
  d = {
    db,
    chain,
    confirmGapMs: 1,
    link: async (privy) => {
      const r = await db.query<{ near: string }>(
        `select w.near_account as near from near_wallets w join accounts a on a.id = w.account_id
         where a.privy_user_id = $1`,
        [privy],
      );
      if (!r.rows[0]) throw new BankError('no wallet', 409);
      return r.rows[0];
    },
  };
});

/** A player with a character, `cents` of `$`, and (unless `wallet: false`) a NEAR wallet. */
async function person(cents: number, opts: { wallet?: boolean } = {}) {
  const k = (n += 1);
  const privy = `did:privy:cars-${Date.now()}-${k}`;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'C') returning id",
    [privy],
  );
  const id = r.rows[0]!.id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 30, 0)',
    [id, `Car Owner${k}`],
  );
  const near = `${String(k).padStart(4, '0')}${'b'.repeat(60)}`;
  if (opts.wallet !== false)
    await db.query('insert into near_wallets (account_id, near_account) values ($1, $2)', [
      id,
      near,
    ]);
  if (cents > 0)
    await transfer(db, {
      kind: 'signup_bonus',
      key: `fund-${id}`,
      legs: [
        { account: await systemAccount(db, 'faucet:signup'), amount: -cents },
        { account: await walletOf(db, id), amount: cents },
      ],
    });
  return { privy, id, near };
}

const sedan = CAR_MODELS.findIndex((m) => m.id === 'sedan');

const tokenFor = async (car: number) =>
  (await db.query<{ asset: string }>('select asset from car_chain where car_id = $1', [car]))
    .rows[0]!.asset;

/** A seller whose sedan is minted to their wallet, its lock over. */
async function owner() {
  const p = await person(carPrice(sedan)!);
  const { car } = await buyCar(db, p.privy, { model: sedan, key: `k-${Date.now()}-${n}` });
  await runMints(d);
  return { ...p, car: car.id, token: await tokenFor(car.id) };
}

/** Runs a step call to the end, signing each step as the player would. */
async function signAll<T>(
  call: (signed: { tx?: string; signature?: string }) => Promise<StepResult<T>>,
): Promise<{ done: T; steps: number }> {
  let r = await call({});
  let steps = 0;
  while (r.step) {
    steps += 1;
    r = await call({ tx: r.step.tx, signature: 'sig' });
  }
  return { done: r.done, steps };
}

const ownerOf = async (car: number) =>
  (
    await db.query<{ account_id: string; away: boolean }>(
      'select account_id, away from owned_cars where id = $1',
      [car],
    )
  ).rows[0]!;

describe('title deeds', () => {
  it('a car bought at the dealer is minted to the buyer’s own wallet, once', async () => {
    const p = await owner();
    expect(chain.owners.get(p.token)).toBe(p.near);
    expect(p.token).toMatch(new RegExp(`^car-${p.car}-[0-9a-f]{6}$`));
    expect(await queueMints(db, p.id)).toBe(0);
    await runMints(d);
    expect(chain.minted.filter((t) => t === p.token)).toHaveLength(1);
    const g = await garageOf(db, p.id);
    expect(g.find((c) => c.id === p.car)).toMatchObject({ token: p.token, minted: true });
  });

  it('the rental is never minted, and a car waits for its owner’s wallet', async () => {
    const p = await person(carPrice(sedan)!, { wallet: false });
    const { car } = await buyCar(db, p.privy, { model: sedan, key: `k-${Date.now()}-${n}` });
    await runMints(d);
    expect(chain.owners.size).toBe(0);
    await db.query('insert into near_wallets (account_id, near_account) values ($1, $2)', [
      p.id,
      p.near,
    ]);
    expect(await queueMints(db, p.id)).toBe(1);
    await runMints(d);
    expect(chain.owners.get(await tokenFor(car.id))).toBe(p.near);
  });

  it('a mint that fails is retried later, without minting twice', async () => {
    const p = await person(carPrice(sedan)!);
    chain.failMints = 1;
    const { car } = await buyCar(db, p.privy, { model: sedan, key: `k-${Date.now()}-${n}` });
    await runMints(d);
    expect(chain.owners.size).toBe(0);
    await db.query('update car_chain set next_at = now() where car_id = $1', [car.id]);
    await runMints(d);
    await runMints(d);
    expect(chain.minted).toEqual([await tokenFor(car.id)]);
  });
});

describe('the garage follows the chain', () => {
  it('a car sent to another player’s wallet moves to their garage', async () => {
    const a = await owner();
    const b = await person(0);
    chain.owners.set(a.token, b.near);
    await syncCars(d, 0);
    expect((await ownerOf(a.car)).account_id).toBe(b.id);
  });

  it('a car held by a wallet no player has linked leaves every garage, and comes back', async () => {
    const a = await owner();
    chain.owners.set(a.token, 'stranger.testnet');
    await syncCars(d, 0);
    expect((await ownerOf(a.car)).away).toBe(true);
    expect((await garageOf(db, a.id)).some((c) => c.id === a.car)).toBe(false);
    chain.owners.set(a.token, a.near);
    await syncCars(d, 0);
    expect(await ownerOf(a.car)).toMatchObject({ account_id: a.id, away: false });
  });

  it('sending in the game is the owner’s own signed step', async () => {
    const a = await owner();
    const b = await person(0);
    const { steps } = await signAll((s) => sendCar(d, a.privy, { car: a.car, to: b.near, ...s }));
    expect(steps).toBe(1);
    expect((await ownerOf(a.car)).account_id).toBe(b.id);
    await expect(sendCar(d, b.privy, { car: a.car, to: 'nope!' })).rejects.toThrow(/NEAR account/);
  });

  it('a locked car can’t be sent or listed yet', async () => {
    const a = await owner();
    chain.locked.set(a.token, Date.now() + 30 * 60_000);
    await expect(sendCar(d, a.privy, { car: a.car, to: 'friend.testnet' })).rejects.toThrow(
      /locked/,
    );
    await expect(
      listOnChain(d, a.privy, { car: a.car, micro: 5 * USDC }, priceBounds, listCar),
    ).rejects.toThrow(/locked/);
  });
});

describe('selling for $, USDC or both', () => {
  it('lists for both in two signed steps, and the USDC buyer gets it on chain', async () => {
    const a = await owner();
    const b = await person(0);
    const price = priceBounds(sedan).min;
    const { done, steps } = await signAll((s) =>
      listOnChain(d, a.privy, { car: a.car, price, micro: 7 * USDC, ...s }, priceBounds, listCar),
    );
    expect(steps).toBe(2);
    expect(chain.offers.has(a.token) && chain.listed.has(a.token)).toBe(true);
    expect((await listings(db)).find((l) => l.id === done.id)).toMatchObject({
      price,
      micro: 7 * USDC,
    });
    chain.usdc.set(b.near, 10n * BigInt(USDC));
    await signAll((s) => buyForUsdc(d, b.privy, { id: done.id, ...s }));
    expect(chain.owners.get(a.token)).toBe(b.near);
    expect((await ownerOf(a.car)).account_id).toBe(b.id);
    expect(chain.offers.has(a.token)).toBe(false);
    // Nothing moved in `$`.
    expect(await balanceOf(db, await walletOf(db, b.id))).toBe(0);
  });

  it('the $ buyer gets it too: paid in $, handed over on chain in the same step', async () => {
    const a = await owner();
    const b = await person(5_000_000);
    const price = priceBounds(sedan).min;
    const { done } = await signAll((s) =>
      listOnChain(d, a.privy, { car: a.car, price, micro: 7 * USDC, ...s }, priceBounds, listCar),
    );
    const handover = {
      tokenFor: (car: number) => dollarSaleToken(d, car),
      buyerWallet: async () => b.near,
      transfer: (t: string, to: string) => chain.gameTransfer(t, to),
    };
    await buyListed(db, b.privy, { id: done.id }, handover);
    expect(chain.handed).toEqual([[a.token, b.near]]);
    expect(chain.listed.has(a.token)).toBe(false);
    expect((await ownerOf(a.car)).account_id).toBe(b.id);
    expect((await audit(db)).total).toBe(0);
  });

  it('if the chain refuses the handover, no $ moves', async () => {
    const a = await owner();
    const b = await person(5_000_000);
    const price = priceBounds(sedan).min;
    const { done } = await signAll((s) =>
      listOnChain(d, a.privy, { car: a.car, price, ...s }, priceBounds, listCar),
    );
    chain.failHandover = true;
    await expect(
      buyListed(
        db,
        b.privy,
        { id: done.id },
        {
          tokenFor: (car) => dollarSaleToken(d, car),
          buyerWallet: async () => b.near,
          transfer: (t, to) => chain.gameTransfer(t, to),
        },
      ),
    ).rejects.toThrow();
    expect(await balanceOf(db, await walletOf(db, b.id))).toBe(5_000_000);
    expect((await ownerOf(a.car)).account_id).toBe(a.id);
  });

  it('a $ sale of a minted car needs the seller’s offer on chain first', async () => {
    const a = await owner();
    const b = await person(5_000_000);
    const { done } = await signAll((s) =>
      listOnChain(
        d,
        a.privy,
        { car: a.car, price: priceBounds(sedan).min, ...s },
        priceBounds,
        listCar,
      ),
    );
    chain.offers.delete(a.token);
    await expect(
      buyListed(
        db,
        b.privy,
        { id: done.id },
        {
          tokenFor: (car) => dollarSaleToken(d, car),
          buyerWallet: async () => b.near,
          transfer: (t, to) => chain.gameTransfer(t, to),
        },
      ),
    ).rejects.toThrow(/allowed this sale/);
    expect(await balanceOf(db, await walletOf(db, b.id))).toBe(5_000_000);
  });

  it('a USDC-only listing can’t be bought for $, and a short wallet can’t buy it', async () => {
    const a = await owner();
    const b = await person(5_000_000);
    const { done } = await signAll((s) =>
      listOnChain(d, a.privy, { car: a.car, micro: 7 * USDC, ...s }, priceBounds, listCar),
    );
    await expect(buyListed(db, b.privy, { id: done.id })).rejects.toThrow(/USDC only/);
    await expect(buyForUsdc(d, b.privy, { id: done.id })).rejects.toThrow(/Not enough USDC/);
    await expect(buyForUsdc(d, a.privy, { id: done.id })).rejects.toThrow(/your own car/);
  });

  it('taking it down undoes both on chain, in the owner’s own steps', async () => {
    const a = await owner();
    const { done } = await signAll((s) =>
      listOnChain(
        d,
        a.privy,
        { car: a.car, price: priceBounds(sedan).min, micro: 7 * USDC, ...s },
        priceBounds,
        listCar,
      ),
    );
    const { steps } = await signAll((s) => unlistOnChain(d, a.privy, { id: done.id, ...s }));
    expect(steps).toBe(2);
    expect(chain.listed.has(a.token) || chain.offers.has(a.token)).toBe(false);
    expect((await listings(db)).some((l) => l.id === done.id)).toBe(false);
  });

  it('a listing made on chain outside the game shows on the market, and its end closes it', async () => {
    const a = await owner();
    chain.listed.set(a.token, { seller: a.near, price: String(9 * USDC) });
    await syncCars(d, 0);
    const l = (await listings(db)).find((x) => x.car_id === a.car);
    expect(l).toMatchObject({ micro: 9 * USDC, price: null });
    chain.listed.delete(a.token);
    await syncCars(d, 0);
    expect((await listings(db)).some((x) => x.car_id === a.car)).toBe(false);
  });

  it('a car not on chain yet still sells for $ the old way, and not for USDC', async () => {
    const p = await person(carPrice(sedan)!, { wallet: false });
    const { car } = await buyCar(db, p.privy, { model: sedan, key: `k-${Date.now()}-${n}` });
    await db.query('insert into near_wallets (account_id, near_account) values ($1, $2)', [
      p.id,
      p.near,
    ]);
    await expect(
      listOnChain(d, p.privy, { car: car.id, micro: 5 * USDC }, priceBounds, listCar),
    ).rejects.toThrow(/on its way/);
    const r = await listOnChain(
      d,
      p.privy,
      { car: car.id, price: priceBounds(sedan).min },
      priceBounds,
      listCar,
    );
    expect(r.done).toBeDefined();
  });
});
