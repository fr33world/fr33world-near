import { interiorAt } from '@fr33world/city';
import {
  ACT,
  type ClientMessage,
  decodeServerFrame,
  encodeClient,
  FLAG,
  MODE,
  modeOf,
  PROTOCOL_VERSION,
  type ServerMessage,
  WEAPON,
} from '@fr33world/protocol';
import {
  ARMORY,
  type Arms,
  FALL,
  fallDamage,
  MAX_HP,
  MEDICAL,
  SHOOT_HEIGHT,
  TICK_HZ,
  WEAPONS,
} from '@fr33world/shared';
import { describe, expect, it } from 'vitest';
import type { Conn } from './transport.ts';
import { World } from './world.ts';

const NONE: Arms = { licence: false, weapons: [], rounds: {} };

class FakeConn implements Conn {
  static next = 20_000;
  readonly id = FakeConn.next++;
  readonly remote = 'test';
  readonly inbox: ServerMessage[] = [];
  closed = false;
  send(bytes: Uint8Array) {
    this.inbox.push(...decodeServerFrame(new Uint8Array(bytes)));
  }
  buffered() {
    return 0;
  }
  close() {
    this.closed = true;
  }
  take<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    const out = this.inbox.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    for (let i = this.inbox.length - 1; i >= 0; i -= 1)
      if (this.inbox[i]?.type === type) this.inbox.splice(i, 1);
    return out;
  }
  told(): string[] {
    return this.take('chat').map((m) => m.text);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A world whose API knows each account's arms (`armsBy`) and records every call. */
function setup(armsBy: Record<string, Arms>) {
  let clock = 1_000_000;
  const calls: [string, Record<string, unknown>][] = [];
  const world = new World({
    now: () => clock,
    safeZones: [],
    authenticate: (token) => Promise.resolve({ account: token, name: `${token} Player` }),
    staffApi: (path, body) => {
      calls.push([path, body]);
      const account = body.account as string;
      if (path === 'jobs/load') return Promise.resolve({ saved: null });
      if (path === 'faction') return Promise.resolve({ membership: null });
      if (path === 'arms') return Promise.resolve({ arms: armsBy[account] });
      if (path === 'arms/buy') {
        const now = armsBy[account] as Arms;
        armsBy[account] = { ...now, licence: true, weapons: [1], rounds: { 1: 28 } };
        return Promise.resolve({ arms: armsBy[account], name: 'Pistol', price: 350_000 });
      }
      return Promise.resolve({});
    },
  });
  const tick = (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock += 1000 / TICK_HZ;
      world.step();
    }
  };
  const send = (conn: Conn, m: ClientMessage) => world.message(conn, encodeClient(m));
  const join = async (token: string) => {
    const conn = new FakeConn();
    world.open(conn);
    send(conn, { type: 'hello', version: PROTOCOL_VERSION, name: 'x', token });
    await settle();
    const w = conn.take('welcome')[0];
    if (!w) throw new Error('no welcome');
    await settle();
    return { conn, id: w.you, pos: { ...w.spawn } };
  };
  const shoot = (
    a: { conn: Conn; pos: { x: number; y: number; z: number } },
    at: { x: number; y: number; z: number },
    weapon: number,
  ) => {
    const o = { x: a.pos.x, y: a.pos.y + SHOOT_HEIGHT, z: a.pos.z };
    const yaw = Math.atan2(at.x - o.x, at.z - o.z);
    const pitch = Math.atan2(at.y + 1.2 - o.y, Math.hypot(at.x - o.x, at.z - o.z));
    send(a.conn, { type: 'shot', seq: 1, weapon, viewTime: world.serverTime(), ...o, yaw, pitch });
  };
  return {
    world,
    calls,
    tick,
    send,
    join,
    shoot,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
  };
}

const armsOf = (conn: FakeConn) =>
  JSON.parse(conn.take('arms').at(-1)?.state ?? '{}') as Arms & {
    inHand: number;
    mag: Record<number, number>;
  };

describe('the armoury in the world', () => {
  it('turns down shots from a weapon the player doesn’t own', async () => {
    const t = setup({
      a: { licence: false, weapons: [], rounds: {} },
      b: { licence: false, weapons: [], rounds: {} },
    });
    const a = await t.join('a');
    const b = await t.join('b');
    t.tick(2);
    t.shoot(a, b.pos, WEAPON.ASSAULT_RIFLE);
    t.send(a.conn, { type: 'equip', weapon: WEAPON.HEAVY_PISTOL });
    t.shoot(a, b.pos, WEAPON.HEAVY_PISTOL);
    expect(b.conn.take('hit')).toHaveLength(0);
    expect(armsOf(a.conn).inHand).toBe(WEAPON.NONE);
  });

  it('fires only what’s in the magazine, reloads in time, and tells the API the rounds spent', async () => {
    const t = setup({
      a: { licence: true, weapons: [1], rounds: { 1: 9 } },
      b: { licence: false, weapons: [], rounds: {} },
    });
    const a = await t.join('a');
    const b = await t.join('b');
    t.tick(2);
    t.send(a.conn, { type: 'equip', weapon: WEAPON.HEAVY_PISTOL });
    expect(armsOf(a.conn)).toMatchObject({ inHand: 1, mag: { 1: WEAPONS[1]?.magazine } });
    const magazine = WEAPONS[1]?.magazine ?? 0;
    const target = (t.world as unknown as { players: Map<number, { hp: number }> }).players.get(
      b.id,
    );
    let hits = 0;
    for (let i = 0; i < magazine + 2; i += 1) {
      t.advance(400);
      // Keep the target standing.
      if (target) target.hp = 100;
      t.shoot(a, b.pos, WEAPON.HEAVY_PISTOL);
      hits += b.conn.take('hit').length;
      t.tick(1);
    }
    // Down for the kill log.
    if (target) target.hp = 10;
    expect(hits).toBe(magazine);
    // Reload: two rounds left, and none fire until it's done.
    t.send(a.conn, { type: 'reload' });
    expect(armsOf(a.conn).mag[1]).toBe(2);
    t.advance(400);
    t.shoot(a, b.pos, WEAPON.HEAVY_PISTOL);
    expect(b.conn.take('hit')).toHaveLength(0);
    t.advance(ARMORY.reloadMs[1] ?? 0);
    t.shoot(a, b.pos, WEAPON.HEAVY_PISTOL);
    expect(b.conn.take('hit').length).toBeGreaterThan(0);
    // Its stance shows to others; the rifle's doesn't.
    t.send(a.conn, {
      type: 'state',
      seq: 5,
      ...a.pos,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      state: MODE.IDLE | FLAG.RIFLE,
    });
    const inner = t.world as unknown as { players: Map<number, { pose: { state: number } }> };
    const state = inner.players.get(a.id)?.pose.state ?? 0;
    expect(state & FLAG.ARMED).toBeTruthy();
    expect(state & FLAG.RIFLE).toBe(0);
    t.world.close(a.conn);
    await settle();
    for (let i = 0; i < 2000 && !t.calls.some(([p]) => p === 'arms/rounds'); i += 1) {
      t.advance(1000);
      t.world.step();
    }
    expect(t.calls.find(([p]) => p === 'arms/rounds')?.[1]).toMatchObject({
      account: 'a',
      used: { 1: magazine + 1 },
    });
    // The ones who went down are in the kill log.
    expect(t.calls.some(([p, body]) => p === 'kills' && body.victimName === 'b Player')).toBe(true);
  });

  it('sells at the Gun Store counter, through the API', async () => {
    const t = setup({ a: { licence: false, weapons: [], rounds: {} } });
    const a = await t.join('a');
    const store = t.world.city.points.findIndex((q) => q.kind === 'gunstore');
    const inner = t.world as unknown as {
      players: Map<number, { pose: { x: number; z: number } }>;
    };
    // Not from across town.
    t.send(a.conn, { type: 'buy', point: store, item: 1 });
    await settle();
    expect(a.conn.told().at(-1)).toMatch(/closer/);
    Object.assign(inner.players.get(a.id)?.pose ?? {}, t.world.city.points[store]);
    t.advance(2000);
    t.send(a.conn, { type: 'buy', point: store, item: 1 });
    await settle();
    expect(t.calls.find(([p]) => p === 'arms/buy')?.[1]).toMatchObject({
      account: 'a',
      item: 'pistol',
    });
    expect(armsOf(a.conn)).toMatchObject({ weapons: [1], mag: { 1: WEAPONS[1]?.magazine } });
    // The rifle isn't sold here.
    t.advance(2000);
    t.send(a.conn, { type: 'buy', point: store, item: 3 });
    await settle();
    expect(a.conn.told().at(-1)).toMatch(/Not sold here/);
  });

  it('wakes the downed in a hospital bed, for a fee', async () => {
    const t = setup({ a: { licence: false, weapons: [], rounds: {} } });
    const a = await t.join('a');
    const inner = t.world as unknown as {
      players: Map<number, { hp: number; downedUntil: number; pose: { x: number; z: number } }>;
    };
    const p = inner.players.get(a.id);
    if (!p) throw new Error('no player');
    p.hp = 0;
    p.downedUntil = 1;
    t.tick(1);
    await settle();
    expect(interiorAt(p.pose.x, p.pose.z)?.id).toBe('hospital');
    expect(p.hp).toBe(MEDICAL.bedStartHp);
    expect(t.calls.find(([path]) => path === 'fare')?.[1]).toMatchObject({
      kind: 'hospital',
      account: 'a',
    });
  });

  describe('going down', () => {
    type Inner = {
      players: Map<
        number,
        {
          hp: number;
          bed: number;
          fallUntil: number;
          downedUntil: number;
          pose: { x: number; z: number; state: number };
          vehicle: number;
        }
      >;
      vehicles: Map<number, { driver: number; pose: { vx: number; vz: number } }>;
    };
    const down = async () => {
      const t = setup({ a: { licence: false, weapons: [], rounds: {} } });
      const a = await t.join('a');
      const inner = t.world as unknown as Inner;
      const p = inner.players.get(a.id);
      if (!p) throw new Error('no player');
      p.hp = 0;
      p.downedUntil = t.now() + 30_000;
      return { t, a, p, inner };
    };

    it('faints straight to a bed, heals there, and gets up beside it at full health', async () => {
      const { t, a, p } = await down();
      t.world.message(a.conn, encodeClient({ type: 'act', what: ACT.FAINT, arg: 0 }));
      expect(p.bed).toBeGreaterThanOrEqual(0);
      t.tick(TICK_HZ * 40);
      expect(p.hp).toBeGreaterThan(MEDICAL.bedStartHp + 20);
      expect(p.hp).toBeLessThan(MAX_HP);
      t.tick((TICK_HZ * MEDICAL.bedMs) / 1000);
      expect(p.bed).toBe(-1);
      expect(p.hp).toBe(MAX_HP);
      expect(p.downedUntil).toBe(0);
      expect(interiorAt(p.pose.x, p.pose.z)?.id).toBe('hospital');
    });

    it('lets them get up early with the health they have', async () => {
      const { t, a, p } = await down();
      t.world.message(a.conn, encodeClient({ type: 'act', what: ACT.FAINT, arg: 0 }));
      t.tick(TICK_HZ * 10);
      t.world.message(a.conn, encodeClient({ type: 'act', what: ACT.GET_UP, arg: 0 }));
      expect(p.bed).toBe(-1);
      expect(p.hp).toBeLessThan(MAX_HP);
      expect(p.downedUntil).toBe(0);
    });

    it('calling EMS gives them longer, and only calls once', async () => {
      const { t, a, p } = await down();
      const before = p.downedUntil;
      t.world.message(a.conn, encodeClient({ type: 'act', what: ACT.CALL_EMS, arg: 0 }));
      expect(p.downedUntil).toBeGreaterThan(before);
      const after = p.downedUntil;
      t.world.message(a.conn, encodeClient({ type: 'act', what: ACT.CALL_EMS, arg: 0 }));
      expect(p.downedUntil).toBe(after);
    });

    it('gives each patient their own bed', async () => {
      const t = setup({ a: NONE, b: NONE });
      const [a, b] = [await t.join('a'), await t.join('b')];
      const inner = t.world as unknown as Inner;
      for (const who of [a, b]) {
        const p = inner.players.get(who.id);
        if (!p) throw new Error('no player');
        p.hp = 0;
        p.downedUntil = t.now() + 30_000;
        t.world.message(who.conn, encodeClient({ type: 'act', what: ACT.FAINT, arg: 0 }));
      }
      expect(inner.players.get(a.id)?.bed).not.toBe(inner.players.get(b.id)?.bed);
    });
  });

  describe('falling out of a moving car', () => {
    const inCar = async (speed: number) => {
      const t = setup({ a: NONE });
      const a = await t.join('a');
      const inner = t.world as unknown as {
        players: Map<
          number,
          { hp: number; vehicle: number; fallUntil: number; pose: { state: number } }
        >;
        vehicles: Map<
          number,
          { pose: { x: number; z: number; vx: number; vz: number }; driver: number }
        >;
      };
      const p = inner.players.get(a.id);
      const [id, v] = [...inner.vehicles.entries()][0] ?? [];
      if (!p || !v || id === undefined) throw new Error('no player or car');
      v.driver = a.id;
      p.vehicle = id;
      v.pose.vx = speed;
      t.world.message(a.conn, encodeClient({ type: 'exit_vehicle' }));
      return { t, p };
    };

    it('just steps out when slow', async () => {
      const { p } = await inCar(3);
      expect(p.hp).toBe(MAX_HP);
      expect(p.fallUntil).toBe(0);
    });

    it('falls and loses more health the faster it was, and gets up', async () => {
      const slow = await inCar(8);
      const fast = await inCar(30);
      expect(slow.p.hp).toBeLessThan(MAX_HP);
      expect(fast.p.hp).toBeLessThan(slow.p.hp);
      expect(fast.p.fallUntil).toBeGreaterThan(0);
      expect(modeOf(fast.p.pose.state)).toBe(MODE.DOWNED);
      fast.t.tick(TICK_HZ * 6);
      expect(fast.p.fallUntil).toBe(0);
      expect(modeOf(fast.p.pose.state)).toBe(MODE.IDLE);
    });

    it('never kills', () => {
      expect(fallDamage(5)).toBe(0);
      expect(fallDamage(1000)).toBe(FALL.maxDamage);
    });
  });
});
