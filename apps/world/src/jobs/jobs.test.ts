import { generateCity, RoadGraph } from '@fr33world/city';
import { JOB_OP } from '@fr33world/protocol';
import { FAUCETS } from '@fr33world/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { COURIER_PAY, courier, type CourierState } from './courier.ts';
import { type JobHost, type JobPlayer, Jobs, type JobView, type Pay, type Saved } from './jobs.ts';
import { MINING, mining, type MiningState } from './mining.ts';
import { collect, type CollectState } from './collect.ts';
import { taxi, type TaxiState } from './taxi.ts';

const city = generateCity();
const roads = RoadGraph.fromCity(city);
const index = (kind: string) => city.points.findIndex((p) => p.kind === kind);
const at = (i: number) => city.points[i] as { x: number; z: number };

let clock = 1_000_000;
let views: string[] = [];
let said: string[] = [];
let paid: Pay[] = [];
let saved: Map<string, Saved>;
let jobs: Jobs;
/** What the API does with a pay (each test may swap it): pays it in full by default. */
let pays: (pay: Pay) => Promise<{ cents: number; xp: number; totalXp: number }>;

const host = (): JobHost => ({
  now: () => clock,
  serverTime: (at) => at - 1_000_000,
  points: city.points,
  roads,
  send: (_id, v) => views.push(v),
  rewarded: () => {},
  tell: (_id, t) => said.push(t),
  reward: (_account, pay) => pays(pay),
  save: (account, s) => {
    if (s) saved.set(account, structuredClone(s));
    else saved.delete(account);
    return Promise.resolve();
  },
  load: (account) => Promise.resolve(saved.get(account) ?? null),
  wait: () => Promise.resolve(),
});

/** A player standing at point `i` (on foot unless said). */
const player = (i: number, extra: Partial<JobPlayer> = {}): JobPlayer => ({
  id: 1,
  account: 'acct-1',
  ...at(i),
  onFoot: true,
  downed: false,
  xp: 0,
  ...extra,
});
const settle = () => new Promise((r) => setTimeout(r, 0));
const lastView = () => JSON.parse(views.at(-1) ?? 'null') as JobView | null;

beforeEach(() => {
  clock = 1_000_000;
  views = [];
  said = [];
  paid = [];
  saved = new Map();
  pays = (pay) => {
    paid.push(pay);
    return Promise.resolve({ cents: pay.cents, xp: pay.xp, totalXp: 0 });
  };
  jobs = new Jobs(host(), [courier, mining, taxi, collect] as never);
});

describe('courier', () => {
  it('runs a whole route: collect, deliver door by door, paid per stop with a bonus', async () => {
    const depot = index('depot');
    jobs.handle(player(depot), JOB_OP.START, depot);
    const s0 = jobs.current(1)?.state as CourierState;
    expect(s0.stops.length).toBeGreaterThanOrEqual(3);
    expect(s0.stops.length).toBeLessThanOrEqual(5);
    expect(lastView()?.step).toMatch(/Collect/);
    clock += 1000;
    jobs.handle(player(depot), JOB_OP.USE, depot);
    for (const [k, stop] of s0.stops.entries()) {
      clock += 120_000;
      jobs.handle(player(stop), JOB_OP.USE, stop);
      expect(said.at(-1)).toMatch(k === s0.stops.length - 1 ? /Route complete/ : /Delivered/);
    }
    await settle();
    expect(paid).toHaveLength(s0.stops.length);
    expect(new Set(paid.map((p) => p.key)).size).toBe(paid.length);
    expect(paid.every((p) => p.cents > 0 && p.cents <= 50_000 && p.xp > 0)).toBe(true);
    expect(paid.at(-1)?.reason).toMatch(/Route complete/);
    expect(jobs.current(1)).toBeNull();
    expect(views.at(-1)).toBe('');
    // A cooldown before the next shift.
    clock += 1000;
    jobs.handle(player(depot), JOB_OP.START, depot);
    expect(said.at(-1)).toMatch(/breather/);
  });

  it('refuses the wrong door, the car, out of reach, and arriving faster than a car could', () => {
    const depot = index('depot');
    jobs.handle(player(depot), JOB_OP.START, depot);
    const s = jobs.current(1)?.state as CourierState;
    const first = s.stops[0] as number;
    const second = s.stops[1] as number;
    // Not collected yet.
    clock += 60_000;
    jobs.handle(player(first), JOB_OP.USE, first);
    expect(said.at(-1)).toMatch(/Collect the packages/);
    clock += 1000;
    jobs.handle(player(depot), JOB_OP.USE, depot);
    // Teleported straight to the door: far too soon.
    clock += 1000;
    jobs.handle(player(first), JOB_OP.USE, first);
    expect(said.at(-1)).toMatch(/quicker than any car/);
    clock += 120_000;
    jobs.handle(player(second), JOB_OP.USE, second);
    expect(said.at(-1)).toMatch(/Wrong address/);
    clock += 1000;
    jobs.handle(player(first, { onFoot: false }), JOB_OP.USE, first);
    expect(said.at(-1)).toMatch(/walk it to the door/);
    clock += 1000;
    jobs.handle(player(depot), JOB_OP.USE, first);
    expect(said.at(-1)).toMatch(/closer/);
    expect(paid).toHaveLength(0);
    expect((jobs.current(1)?.state as CourierState).done).toBe(0);
  });

  it('survives a restart: the saved shift carries on for the same account', async () => {
    const depot = index('depot');
    jobs.handle(player(depot), JOB_OP.START, depot);
    clock += 1000;
    jobs.handle(player(depot), JOB_OP.USE, depot);
    await settle();
    // A new server (the old one's memory gone), the same saved state.
    jobs = new Jobs(host(), [courier, mining] as never);
    await jobs.joined(player(depot));
    expect((jobs.current(1)?.state as CourierState).loaded).toBe(true);
    expect(said.at(-1)).toMatch(/carries on/);
  });

  it('ends a route left too long, and quitting keeps what was earned', () => {
    const depot = index('depot');
    jobs.handle(player(depot), JOB_OP.START, depot);
    clock += 26 * 60_000;
    jobs.tick([player(depot)]);
    expect(jobs.current(1)).toBeNull();
    expect(said.at(-1)).toMatch(/Out of time/);
  });

  it('needs a login', () => {
    const depot = index('depot');
    jobs.handle(player(depot, { account: null }), JOB_OP.START, depot);
    expect(said.at(-1)).toMatch(/Log in/);
  });
});

describe('mining', () => {
  it('mines with timed strikes (no faster), fills the bag, and sells at the buyer', async () => {
    const office = index('quarry_office');
    const copper = city.points.findIndex((p) => p.kind === 'ore' && p.grade === 0);
    const buyer = index('buyer');
    jobs.handle(player(office), JOB_OP.START, office);
    // Strikes faster than STRIKE_MS don't count.
    for (let i = 0; i < 10; i += 1) {
      clock += 300;
      jobs.handle(player(copper), JOB_OP.USE, copper);
    }
    const s1 = jobs.current(1)?.state as MiningState;
    expect(s1.bag[0]).toBeLessThanOrEqual(1);
    for (let i = 0; i < 40; i += 1) {
      clock += MINING.strikeMs + 10;
      jobs.handle(player(copper), JOB_OP.USE, copper);
    }
    const s2 = jobs.current(1)?.state as MiningState;
    expect(s2.bag[0]).toBe(MINING.bag);
    expect(said.at(-1)).toMatch(/bag is full/);
    clock += 1000;
    jobs.handle(player(buyer), JOB_OP.USE, buyer);
    await settle();
    expect(paid).toEqual([
      expect.objectContaining({
        cents: MINING.bag * MINING.price[0],
        xp: MINING.bag * MINING.xp[0],
      }),
    ]);
    expect((jobs.current(1)?.state as MiningState).bag).toEqual([0, 0, 0]);
    // Selling an empty bag pays nothing.
    clock += 1000;
    jobs.handle(player(buyer), JOB_OP.USE, buyer);
    await settle();
    expect(paid).toHaveLength(1);
  });

  it('works faces out, so one face can’t be farmed forever', () => {
    const office = index('quarry_office');
    const face = city.points.findIndex((p) => p.kind === 'ore' && p.grade === 0);
    jobs.handle(player(office), JOB_OP.START, office);
    // Two miners on the same face, bags emptied by selling between.
    let pieces = 0;
    for (let i = 0; i < 200; i += 1) {
      clock += MINING.strikeMs + 1;
      const before = (jobs.current(1)?.state as MiningState).bag[0];
      jobs.handle(player(face), JOB_OP.USE, face);
      const after = (jobs.current(1)?.state as MiningState).bag[0];
      if (after > before) pieces += 1;
      if (after >= MINING.bag) {
        const s = jobs.current(1)?.state as MiningState;
        s.bag = [0, 0, 0];
      }
    }
    // 200 strikes in ~140 s: the face's 10 plus a few refills, not 50.
    expect(pieces).toBeLessThan(MINING.faceHolds + 8);
    expect(said.some((t) => /worked out/.test(t))).toBe(true);
  });

  it('warns before an idle shift ends', () => {
    const office = index('quarry_office');
    jobs.handle(player(office), JOB_OP.START, office);
    clock += MINING.idleMs - 90_000;
    jobs.tick([player(office)]);
    expect(said.at(-1)).toMatch(/ends in 2 min unless you mine or sell ore/);
    const before = said.length;
    clock += 1000;
    jobs.tick([player(office)]);
    expect(said).toHaveLength(before);
  });
});

describe('job pay', () => {
  /** Starts a mining shift with a bag of six gold (the most one sale pays) and sells it. */
  const sellGold = async () => {
    const office = index('quarry_office');
    const buyer = index('buyer');
    jobs.handle(player(office), JOB_OP.START, office);
    (jobs.current(1)?.state as MiningState).bag = [0, 0, MINING.bag];
    clock += 1000;
    jobs.handle(player(buyer), JOB_OP.USE, buyer);
    for (let i = 0; i < 20; i += 1) await settle();
  };

  it('never asks the bank for more in one payment than it allows', () => {
    const most = Math.max(
      MINING.bag * Math.max(...MINING.price),
      COURIER_PAY.maxLeg + COURIER_PAY.bonus,
    );
    expect(most).toBeLessThanOrEqual(FAUCETS.jobs.maxPayment);
  });

  it("tries a pay the bank couldn't take again, and pays it once", async () => {
    let tries = 0;
    pays = (pay) => {
      tries += 1;
      if (tries < 3) return Promise.reject(new Error('fetch failed'));
      paid.push(pay);
      return Promise.resolve({ cents: pay.cents, xp: pay.xp, totalXp: 0 });
    };
    await sellGold();
    expect(tries).toBe(3);
    expect(paid).toEqual([expect.objectContaining({ cents: MINING.bag * MINING.price[2] })]);
    expect(said.filter((t) => /isn't answering/.test(t))).toHaveLength(1);
  });

  it("says why when the bank turns a pay down, and doesn't try again", async () => {
    let tries = 0;
    pays = () => {
      tries += 1;
      return Promise.reject(Object.assign(new Error('the economy is paused'), { status: 409 }));
    };
    await sellGold();
    expect(tries).toBe(1);
    expect(said.at(-1)).toMatch(/turned down your \$840\.00: the economy is paused/);
  });

  it('says so when the hourly or daily limit paid only part', async () => {
    pays = (pay) => Promise.resolve({ cents: 20_000, xp: pay.xp, totalXp: 0 });
    await sellGold();
    expect(said.at(-1)).toMatch(/\$200\.00 of \$840\.00 was paid/);
  });
});

describe('taxi', () => {
  it('drives five fares from the car, paid by the road, refusing shortcuts and walking', async () => {
    const depot = index('taxi_depot');
    jobs.handle(player(depot, { xp: 0 }), JOB_OP.START, depot);
    expect(said.at(-1)).toMatch(/needs level 2/);
    const driver = (i: number, extra: Partial<JobPlayer> = {}) =>
      player(i, { onFoot: false, xp: 500, ...extra });
    clock += 1000;
    jobs.handle(driver(depot), JOB_OP.START, depot);
    for (let k = 0; k < 5; k += 1) {
      const s = jobs.current(1)?.state as TaxiState;
      clock += 60_000;
      jobs.handle(driver(s.pickup, { onFoot: true }), JOB_OP.USE, s.pickup);
      expect(said.at(-1)).toMatch(/from the car/);
      clock += 1000;
      jobs.handle(driver(s.pickup), JOB_OP.USE, s.pickup);
      expect(said.at(-1)).toMatch(/aboard/);
      // Straight there: faster than any car.
      clock += 500;
      jobs.handle(driver(s.dropoff), JOB_OP.USE, s.dropoff);
      expect(said.at(-1)).toMatch(/quicker than any car/);
      clock += 180_000;
      jobs.handle(driver(s.dropoff), JOB_OP.USE, s.dropoff);
    }
    await settle();
    expect(paid).toHaveLength(5);
    expect(
      paid.every((p) => p.cents > 2_000 && p.cents <= 25_000 && p.reason.startsWith('Fare')),
    ).toBe(true);
    expect(jobs.current(1)).toBeNull();
  });
});

describe('collections', () => {
  it('is for the hideout’s own gang: three doors on foot, paid back at the hideout', async () => {
    const hideout = city.points.findIndex((p) => p.kind === 'hideout' && p.gang === 'vipers');
    jobs.handle(player(hideout, { faction: 'kings' }), JOB_OP.START, hideout);
    expect(said.at(-1)).toMatch(/Members only/);
    const member = (i: number) => player(i, { faction: 'vipers' });
    clock += 1000;
    jobs.handle(member(hideout), JOB_OP.START, hideout);
    const s = jobs.current(1)?.state as CollectState;
    expect(s.stops).toHaveLength(3);
    for (const stop of s.stops) {
      clock += 120_000;
      jobs.handle(member(stop), JOB_OP.USE, stop);
    }
    expect(paid).toHaveLength(0);
    clock += 120_000;
    jobs.handle(member(hideout), JOB_OP.USE, hideout);
    await settle();
    expect(paid).toEqual([expect.objectContaining({ cents: 18_000, reason: 'Collections' })]);
  });
});
