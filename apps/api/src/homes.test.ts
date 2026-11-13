/* eslint-disable @typescript-eslint/require-await -- the stand-in chain answers at once */
import { HOME_ASSETS, homePrice } from '@fr33world/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import {
  buyHome,
  type HomeChain,
  type HomeDeps,
  homesView,
  queueHomeMints,
  runHomeMints,
  syncHomes,
} from './homes.ts';
import { audit, balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

/** The homes contract, as far as the game can tell: who holds which deed. */
class FakeHomes implements HomeChain {
  owners = new Map<string, string>();
  minted: { token: string; title: string; media: string | null }[] = [];
  failMints = 0;
  homesAccount = () => 'homes.test';
  homeDeedUrl = (t: string) => `https://explorer.test/${t}`;
  async mintHome(token: string, owner: string, m: { title: string; media: string | null }) {
    if (this.failMints > 0) {
      this.failMints -= 1;
      throw new Error('rpc down');
    }
    if (this.owners.has(token)) throw new Error('token_id must be unique');
    this.owners.set(token, owner);
    this.minted.push({ token, title: m.title, media: m.media });
    return { tx: `mint-${token}` };
  }
  async homeToken(token: string) {
    const owner = this.owners.get(token);
    return owner ? { token_id: token, owner_id: owner } : null;
  }
  async homeTokens(from: number, limit: number) {
    return [...this.owners]
      .slice(from, from + limit)
      .map(([token_id, owner_id]) => ({ token_id, owner_id }));
  }
}

let db: Db;
let chain: FakeHomes;
let d: HomeDeps;
let n = 0;
/** Villas still free in this test database (each test takes its own). */
let nextVilla = 0;
const villa = () => nextVilla++;

beforeAll(async () => {
  db = await testDb('homes');
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => {
  chain = new FakeHomes();
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

/** A player with a character, `cents` of `$`, and (unless `guest`) a NEAR wallet. */
async function person(cents: number, opts: { guest?: boolean } = {}) {
  const k = (n += 1);
  const privy = `did:privy:homes-${Date.now()}-${k}`;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name, is_guest) values ($1, 'H', $2) returning id",
    [privy, opts.guest === true],
  );
  const id = r.rows[0]!.id;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 30, 0)',
    [id, `Home Owner${k}`],
  );
  const near = `${String(k).padStart(4, '0')}${'h'.repeat(60)}`;
  if (!opts.guest)
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
  return { id, privy, near, name: `Home Owner${k}` };
}

const key = () => `home-${crypto.randomUUID()}`;
const RICH = 500_000_000;

describe('buying a home', () => {
  it('pays the price once, makes it theirs, and queues its deed for their wallet', async () => {
    const p = await person(RICH);
    const v = villa();
    const k = key();
    const price = homePrice(v) as number;
    const a = await buyHome(db, p.privy, { villa: v, key: k });
    expect(a.home).toMatchObject({ villa: v, mine: true, owner: p.name });
    expect(a.balance).toBe(RICH - price);
    // The same request again (a lost answer): no second charge.
    const b = await buyHome(db, p.privy, { villa: v, key: k });
    expect(b.balance).toBe(RICH - price);
    expect(b.home.mine).toBe(true);
    expect(await balanceOf(db, await walletOf(db, p.id))).toBe(RICH - price);
    const q = await db.query<{ status: string; wallet: string; asset: string }>(
      'select status, wallet, asset from home_chain where villa = $1',
      [v],
    );
    expect(q.rows[0]).toMatchObject({ status: 'mint', wallet: p.near });
    expect(q.rows[0]?.asset).toMatch(new RegExp(`^home-${v}-[0-9a-f]{6}$`));
    expect(await audit(db)).toMatchObject({ unbalanced: 0, drifted: 0 });
  });

  it('can’t be bought twice, and the second buyer keeps their money', async () => {
    const a = await person(RICH);
    const b = await person(RICH);
    const v = villa();
    await buyHome(db, a.privy, { villa: v, key: key() });
    await expect(buyHome(db, b.privy, { villa: v, key: key() })).rejects.toThrow(/already owns/);
    expect(await balanceOf(db, await walletOf(db, b.id))).toBe(RICH);
    const view = (await homesView(db, b.id))[v];
    expect(view).toMatchObject({ owner: a.name, mine: false });
  });

  it('two buyers at the same moment: one gets it, the other pays nothing', async () => {
    const a = await person(RICH);
    const b = await person(RICH);
    const v = villa();
    const got = await Promise.allSettled([
      buyHome(db, a.privy, { villa: v, key: key() }),
      buyHome(db, b.privy, { villa: v, key: key() }),
    ]);
    expect(got.filter((g) => g.status === 'fulfilled')).toHaveLength(1);
    const left = [
      await balanceOf(db, await walletOf(db, a.id)),
      await balanceOf(db, await walletOf(db, b.id)),
    ].sort((x, y) => x - y);
    expect(left[1]).toBe(RICH);
    expect(left[0]).toBe(RICH - (homePrice(v) as number));
  });

  it('refuses guests, the short of money, a villa that doesn’t exist, and past the limit', async () => {
    const guest = await person(RICH, { guest: true });
    await expect(buyHome(db, guest.privy, { villa: villa(), key: key() })).rejects.toThrow(
      /NEAR wallet/,
    );
    const poor = await person(100);
    await expect(buyHome(db, poor.privy, { villa: villa(), key: key() })).rejects.toThrow(
      /Not enough money/,
    );
    const p = await person(RICH * 4);
    await expect(buyHome(db, p.privy, { villa: 9999, key: key() })).rejects.toThrow(
      /isn’t for sale/,
    );
    for (let i = 0; i < HOME_ASSETS.perPlayer; i += 1)
      await buyHome(db, p.privy, { villa: villa(), key: key() });
    await expect(buyHome(db, p.privy, { villa: villa(), key: key() })).rejects.toThrow(/at most/);
  });
});

describe('title deeds on chain', () => {
  it('mints each queued deed once, to the buyer, with the villa’s name and picture', async () => {
    const p = await person(RICH);
    const v = villa();
    await buyHome(db, p.privy, { villa: v, key: key() });
    // Deeds earlier tests queued wait their turn: this test watches its own.
    await db.query(
      "update home_chain set next_at = now() + interval '1 day' where villa <> $1 and status = 'mint'",
      [v],
    );
    chain.failMints = 1;
    expect(await runHomeMints(d)).toBe(0);
    // The failed one waits out its backoff; bring it forward.
    await db.query('update home_chain set next_at = now() where villa = $1', [v]);
    expect(await runHomeMints(d)).toBe(1);
    const m = chain.minted.find((x) => x.token.startsWith(`home-${v}-`));
    expect(m?.title).toMatch(/^Villa, /);
    expect(m?.media).toBe(`${HOME_ASSETS.mediaBase}villa-${v}.webp`);
    expect([...chain.owners.values()]).toContain(p.near);
    const view = (await homesView(db, p.id, chain.homeDeedUrl))[v];
    expect(view?.deed).toMatchObject({ minted: true });
    expect(view?.deed?.url).toMatch(/^https:\/\/explorer\.test\/home-/);
    // Running again mints nothing new.
    const before = chain.minted.length;
    await queueHomeMints(db, p.id);
    await runHomeMints(d);
    expect(chain.minted.length).toBe(before);
  });

  it('follows the chain: sent to another player it’s theirs, sent outside it’s nobody’s', async () => {
    const a = await person(RICH);
    const b = await person(0);
    const v = villa();
    await buyHome(db, a.privy, { villa: v, key: key() });
    await runHomeMints(d);
    const token = [...chain.owners].find(([t]) => t.startsWith(`home-${v}-`))?.[0] as string;
    chain.owners.set(token, b.near);
    await syncHomes(d, 0);
    expect((await homesView(db, b.id))[v]).toMatchObject({ mine: true, owner: b.name });
    chain.owners.set(token, 'someone.testnet');
    await syncHomes(d, 0);
    expect((await homesView(db, b.id))[v]).toMatchObject({ mine: false, owner: 'Someone' });
    // Back to a linked wallet: home again.
    chain.owners.set(token, a.near);
    await syncHomes(d, 0);
    expect((await homesView(db, a.id))[v]).toMatchObject({ mine: true, owner: a.name });
  });
});
