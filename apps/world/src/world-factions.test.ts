import {
  CollisionIndex,
  DOOR,
  FLOORS,
  generateCity,
  INTERIORS,
  interiorAt,
  type Seat,
  SEAT_STEP_M,
} from '@fr33world/city';
import {
  ACT,
  type ClientMessage,
  decodeServerFrame,
  EMOTES,
  encodeClient,
  MODE,
  modeOf,
  PROTOCOL_VERSION,
  type ServerMessage,
  WEAPON,
} from '@fr33world/protocol';
import { type Membership, ON_DUTY_BIT, SALARY, TICK_HZ } from '@fr33world/shared';
import { describe, expect, it } from 'vitest';
import type { Conn } from './transport.ts';
import { World } from './world.ts';

class FakeConn implements Conn {
  static next = 30_000;
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
const lockers = generateCity().points;

function setup(members: Record<string, Membership | null>) {
  let clock = 1_000_000;
  const calls: [string, Record<string, unknown>][] = [];
  const world = new World({
    now: () => clock,
    safeZones: [],
    authenticate: (token) => Promise.resolve({ account: token, name: `${token} Player` }),
    staffApi: (path, body) => {
      calls.push([path, body]);
      if (path === 'jobs/load') return Promise.resolve({ saved: null });
      if (path === 'arms')
        return Promise.resolve({ arms: { licence: false, weapons: [], rounds: {} } });
      if (path === 'faction')
        return Promise.resolve({ membership: members[body.account as string] ?? null });
      if (path === 'reward')
        return Promise.resolve({ cents: body.cents, xp: body.xp, totalXp: 100 });
      if (path === 'faction/decide')
        return Promise.resolve({ name: body.name, faction: 'police', accepted: body.accept });
      if (path === 'faction/fine') return Promise.resolve({ name: body.name, cents: body.cents });
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
    return { conn, id: w.you };
  };
  const say = async (conn: FakeConn, text: string) => {
    clock += 2000;
    send(conn, { type: 'chat', text });
    await settle();
    await settle();
  };
  const inner = world as unknown as {
    players: Map<
      number,
      {
        pose: { x: number; z: number; state: number };
        hp: number;
        downedUntil: number;
        movedAt: number;
      }
    >;
  };
  /** To their lockers, and on (or off) duty. */
  const duty = async (who: { conn: FakeConn; id: number }, service = 'police') => {
    const locker = lockers.find((p) => p.kind === 'locker' && p.service === service);
    const body = inner.players.get(who.id);
    if (!locker || !body) throw new Error('no locker or player');
    Object.assign(body.pose, { x: locker.x, z: locker.z });
    await say(who.conn, '/duty');
  };
  return {
    world,
    calls,
    tick,
    send,
    join,
    say,
    duty,
    inner,
    advance: (ms: number) => (clock += ms),
  };
}

describe('factions in the world', () => {
  it('pays on-duty police for active time only, and lends a duty pistol', async () => {
    const t = setup({ cop: { faction: 'police', rank: 2 } });
    const cop = await t.join('cop');
    await t.duty(cop);
    expect(cop.conn.told().at(-1)).toMatch(/On duty as Officer/);
    const arms = JSON.parse(cop.conn.take('arms').at(-1)?.state ?? '{}') as { weapons: number[] };
    expect(arms.weapons).toContain(WEAPON.HEAVY_PISTOL);
    // Standing still the whole time: away, so no pay.
    const p = t.inner.players.get(cop.id);
    if (!p) throw new Error();
    t.tick(TICK_HZ * (SALARY.everyMs / 1000 + 5));
    expect(t.calls.some(([path]) => path === 'reward')).toBe(false);
    // Moving about: paid once per period.
    for (let s = 0; s < SALARY.everyMs / 1000 + 2; s += 1) {
      p.movedAt = Infinity;
      t.tick(TICK_HZ);
    }
    await settle();
    const pay = t.calls.find(([path]) => path === 'reward')?.[1];
    expect(pay).toMatchObject({ account: 'cop', source: 'faction', cents: 20_000 });
    await t.duty(cop);
    const after = JSON.parse(cop.conn.take('arms').at(-1)?.state ?? '{}') as { weapons: number[] };
    expect(after.weapons).not.toContain(WEAPON.HEAVY_PISTOL);
  });

  it('tells a caller how their call is going, and lets them hang up', async () => {
    const t = setup({ cop: { faction: 'police', rank: 1 } });
    const cop = await t.join('cop');
    const civ = await t.join('civ');
    await t.duty(cop);
    const call = () =>
      (
        JSON.parse(civ.conn.take('arms').at(-1)?.state ?? '{}') as {
          call: { id: number; onDuty: number; responders: string[] } | null;
        }
      ).call;
    await t.say(civ.conn, '/911 Robbery');
    const open = call();
    expect(open).toMatchObject({ kind: 'police', onDuty: 1, responders: [] });
    await t.say(civ.conn, '/911 Robbery again');
    expect(civ.conn.told().at(-1)).toMatch(/still open/);
    await t.say(cop.conn, `/respond ${open?.id}`);
    expect(call()?.responders).toEqual(['cop Player']);
    await t.say(civ.conn, '/hangup');
    expect(call()).toBeNull();
    expect(JSON.parse(cop.conn.take('dispatch').at(-1)?.state ?? '[1]')).toEqual([]);
    await t.say(civ.conn, '/hangup');
    expect(civ.conn.told().at(-1)).toMatch(/No call/);
  });

  it('puts 911 calls and people down on the dispatch, and a medic revives', async () => {
    const t = setup({ cop: { faction: 'police', rank: 1 }, doc: { faction: 'medical', rank: 2 } });
    const cop = await t.join('cop');
    const doc = await t.join('doc');
    const civ = await t.join('civ');
    await t.duty(cop);
    await t.duty(doc, 'hospital');
    cop.conn.take('dispatch');
    await t.say(civ.conn, '/911 someone stole my car');
    expect(cop.conn.told().at(-1)).toMatch(/civ Player: someone stole my car/);
    const calls = JSON.parse(cop.conn.take('dispatch').at(-1)?.state ?? '[]') as { id: number }[];
    expect(calls).toHaveLength(1);
    await t.say(cop.conn, `/respond ${calls[0]?.id}`);
    expect(civ.conn.told().at(-1)).toMatch(/cop Player is on the way/);
    // Someone down: on the EMS dispatch; the medic beside them gets them up.
    const c = t.inner.players.get(civ.id);
    const d = t.inner.players.get(doc.id);
    if (!c || !d) throw new Error();
    c.hp = 0;
    c.downedUntil = 1e12;
    const w = t.world as unknown as { incident: (...a: unknown[]) => number };
    w.incident('medical', 'Person down', c.pose.x, c.pose.z, civ.id);
    expect(JSON.parse(doc.conn.take('dispatch').at(-1)?.state ?? '[]')).toHaveLength(1);
    Object.assign(d.pose, { x: c.pose.x + 1, z: c.pose.z });
    t.send(doc.conn, { type: 'revive', target: civ.id });
    expect(c.downedUntil).toBe(0);
    expect(civ.conn.take('health').at(-1)).toMatchObject({ downed: false });
    expect(JSON.parse(doc.conn.take('dispatch').at(-1)?.state ?? '[]')).toHaveLength(0);
  });

  it('sends recruiting and fines to the API with the officer’s account', async () => {
    const t = setup({ chief: { faction: 'police', rank: 5 } });
    const chief = await t.join('chief');
    const civ = await t.join('civ');
    await t.say(chief.conn, '/accept "civ Player"');
    expect(t.calls.find(([p]) => p === 'faction/decide')?.[1]).toMatchObject({
      actor: 'chief',
      name: 'civ Player',
      accept: true,
    });
    expect(civ.conn.told().some((l) => /welcome to Los Soles Police/.test(l))).toBe(true);
    // A fine needs duty and to be near.
    await t.say(chief.conn, '/fine "civ Player" 250 speeding');
    expect(chief.conn.told().at(-1)).toMatch(/officers on duty/);
    await t.duty(chief);
    const a = t.inner.players.get(chief.id);
    const b = t.inner.players.get(civ.id);
    if (!a || !b) throw new Error();
    Object.assign(b.pose, { x: a.pose.x + 2, z: a.pose.z });
    await t.say(chief.conn, '/fine "civ Player" 250 speeding through the plaza');
    expect(t.calls.find(([p]) => p === 'faction/fine')?.[1]).toMatchObject({
      actor: 'chief',
      name: 'civ Player',
      cents: 25_000,
      reason: 'speeding through the plaza',
    });
    expect(civ.conn.told().at(-1)).toMatch(/fined you \$250/);
  });

  describe('public buildings', () => {
    const points = generateCity().points;
    const entrance = (id: string) =>
      points.findIndex((p) => p.kind === 'entrance' && p.service === id);
    const exit = (id: string) => points.findIndex((p) => p.kind === 'exit' && p.service === id);
    const at = (t: ReturnType<typeof setup>, id: number, point: number) => {
      const p = points[point];
      const body = t.inner.players.get(id);
      if (!p || !body) throw new Error('no such point or player');
      Object.assign(body.pose, { x: p.x, z: p.z });
    };

    it('walks anyone through the Hospital door and back out', async () => {
      const t = setup({});
      const a = await t.join('ada');
      at(t, a.id, entrance('hospital'));
      a.conn.take('correction');
      t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: entrance('hospital') });
      const inside = a.conn.take('correction')[0];
      expect(inside && interiorAt(inside.x, inside.z)?.id).toBe('hospital');
      at(t, a.id, exit('hospital'));
      t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: exit('hospital') });
      const out = a.conn.take('correction')[0];
      expect(out && interiorAt(out.x, out.z)).toBeNull();
      expect(out && Math.hypot(out.x - (points[entrance('hospital')]?.x ?? 0), 0)).toBeLessThan(4);
    });

    it('lands you clear of the rings at both ends, so a door never throws you straight back', async () => {
      const t = setup({});
      const a = await t.join('ada');
      const door = points[entrance('hospital')];
      const way = points[exit('hospital')];
      if (!door || !way) throw new Error('no door');
      at(t, a.id, entrance('hospital'));
      a.conn.take('correction');
      t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: entrance('hospital') });
      const inside = a.conn.take('correction')[0];
      if (!inside) throw new Error('not let in');
      expect(Math.hypot(inside.x - way.x, inside.z - way.z)).toBeGreaterThan(way.radius + 2);
      at(t, a.id, exit('hospital'));
      t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: exit('hospital') });
      const out = a.conn.take('correction')[0];
      if (!out) throw new Error('not let out');
      expect(Math.hypot(out.x - door.x, out.z - door.z)).toBeGreaterThan(door.radius + DOOR.rearm);
    });

    describe('seats', () => {
      const lobby = INTERIORS.police;
      const seat = lobby.seats[0] as Seat;
      const seated = async (t: ReturnType<typeof setup>, who: string) => {
        const a = await t.join(who);
        at(t, a.id, entrance('police'));
        t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: entrance('police') });
        Object.assign(t.inner.players.get(a.id)?.pose ?? {}, {
          x: seat.x + 0.8,
          z: seat.z + 0.8,
        });
        a.conn.take('correction');
        a.conn.take('arms');
        return a;
      };
      const armsOf = (conn: FakeConn) =>
        JSON.parse(conn.take('arms').at(-1)?.state ?? '{}') as { seat?: Seat | null };

      it('sits a player on a free seat beside them, and says so', async () => {
        const t = setup({});
        const a = await seated(t, 'ada');
        t.send(a.conn, { type: 'act', what: ACT.SIT, arg: 0 });
        const placed = a.conn.take('correction')[0];
        expect(placed?.x).toBeCloseTo(seat.x, 1);
        expect(placed?.z).toBeCloseTo(seat.z, 1);
        expect(armsOf(a.conn).seat).toEqual(seat);
        expect(modeOf(t.inner.players.get(a.id)?.pose.state ?? 0)).toBe(MODE.SITTING);
      });

      it('keeps a seat to one person', async () => {
        const t = setup({});
        const a = await seated(t, 'ada');
        const b = await seated(t, 'bea');
        t.send(a.conn, { type: 'act', what: ACT.SIT, arg: 0 });
        t.send(b.conn, { type: 'act', what: ACT.SIT, arg: 0 });
        expect(b.conn.told().at(-1)).toMatch(/sitting there/);
        expect(b.conn.take('correction')).toHaveLength(0);
      });

      it('doesn’t reach a seat across the room', async () => {
        const t = setup({});
        const a = await seated(t, 'ada');
        const far = lobby.seats.findIndex((q) => Math.hypot(q.x - seat.x, q.z - seat.z) > 6);
        t.send(a.conn, { type: 'act', what: ACT.SIT, arg: far });
        expect(a.conn.take('correction')).toHaveLength(0);
      });

      it('stands up in front of the seat, ignoring walking until then', async () => {
        const t = setup({});
        const a = await seated(t, 'ada');
        t.send(a.conn, { type: 'act', what: ACT.SIT, arg: 0 });
        a.conn.take('correction');
        const body = t.inner.players.get(a.id);
        t.send(a.conn, {
          type: 'state',
          seq: 99,
          x: seat.x + 2,
          y: 0,
          z: seat.z + 2,
          yaw: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          state: MODE.IDLE,
        });
        expect(body?.pose.x).toBeCloseTo(seat.x);
        t.send(a.conn, { type: 'act', what: ACT.STAND, arg: 0 });
        const up = a.conn.take('correction')[0];
        expect(up && Math.hypot(up.x - seat.x, up.z - seat.z)).toBeCloseTo(SEAT_STEP_M, 1);
        expect(armsOf(a.conn).seat).toBeNull();
        expect(modeOf(body?.pose.state ?? 0)).toBe(MODE.IDLE);
      });

      it('frees the seat when they drop', async () => {
        const t = setup({});
        const a = await seated(t, 'ada');
        const b = await seated(t, 'bea');
        t.send(a.conn, { type: 'act', what: ACT.SIT, arg: 0 });
        t.world.close(a.conn);
        t.send(b.conn, { type: 'act', what: ACT.SIT, arg: 0 });
        expect(b.conn.take('correction')[0]?.x).toBeCloseTo(seat.x, 1);
      });

      it('gets up clear of the furniture at every seat in every room', () => {
        const collision = CollisionIndex.fromCity(generateCity());
        const t = setup({});
        const world = t.world as unknown as { frontOf(s: Seat): { x: number; z: number } };
        for (const room of Object.values(INTERIORS))
          for (const s of room.seats) {
            const up = world.frontOf(s);
            expect(collision.pointBlocked(up.x, up.z, 0.25), `${room.id} ${s.x},${s.z}`).toBe(
              false,
            );
          }
      });
    });

    it('heals with a bandage, and shows it to the player and to those near', async () => {
      const t = setup({});
      const a = await t.join('ada');
      const near = await t.join('bea');
      const body = t.inner.players.get(a.id) as unknown as {
        hp: number;
        arms: { care: Record<string, number> };
      };
      body.hp = 40;
      body.arms = { ...body.arms, care: { bandage: 2 } };
      a.conn.take('emote');
      near.conn.take('emote');
      t.send(a.conn, { type: 'act', what: ACT.USE_CARE, arg: 0 });
      expect(a.conn.take('health').at(-1)?.hp).toBe(65);
      expect(body.arms.care.bandage).toBe(1);
      const bandage = EMOTES.findIndex((e) => e.clip === 'bandaging');
      expect(a.conn.take('emote')[0]).toMatchObject({ from: a.id, emote: bandage });
      expect(near.conn.take('emote')[0]).toMatchObject({ from: a.id, emote: bandage });
    });

    it('shows nothing when using one is refused', async () => {
      const t = setup({});
      const a = await t.join('ada');
      const body = t.inner.players.get(a.id) as unknown as {
        hp: number;
        hurtAt: number;
        arms: { care: Record<string, number> };
      };
      body.hp = 40;
      body.hurtAt = 1_000_000;
      body.arms = { ...body.arms, care: { medicine: 1 } };
      a.conn.take('emote');
      t.send(a.conn, { type: 'act', what: ACT.USE_CARE, arg: 1 });
      expect(a.conn.take('emote')).toHaveLength(0);
      expect(body.hp).toBe(40);
      expect(body.arms.care.medicine).toBe(1);
    });

    it('does nothing from across town', async () => {
      const t = setup({});
      const a = await t.join('ada');
      a.conn.take('correction');
      t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: entrance('police') });
      expect(a.conn.take('correction')).toHaveLength(0);
    });

    it('keeps a gang house to its members', async () => {
      const t = setup({ vee: { faction: 'vipers', rank: 1 } });
      const out = await t.join('ada');
      const vee = await t.join('vee');
      for (const who of [out, vee]) at(t, who.id, entrance('vipers'));
      out.conn.take('correction');
      vee.conn.take('correction');
      t.send(out.conn, { type: 'act', what: ACT.DOOR, arg: entrance('vipers') });
      t.send(vee.conn, { type: 'act', what: ACT.DOOR, arg: entrance('vipers') });
      expect(out.conn.take('correction')).toHaveLength(0);
      expect(out.conn.told().join()).toContain('members only');
      expect(vee.conn.take('correction')).toHaveLength(1);
    });

    it('lets a body walk about inside a room, but not through its walls', async () => {
      const t = setup({});
      const a = await t.join('ada');
      const body = t.inner.players.get(a.id);
      if (!body) throw new Error('no player');
      at(t, a.id, entrance('police'));
      t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: entrance('police') });
      const room = INTERIORS.police;
      const walk = (seq: number, x: number, z: number) => {
        t.advance(800);
        t.tick(1);
        t.send(a.conn, { type: 'state', seq, x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw: 0, state: 1 });
      };
      t.advance(800);
      walk(1, room.spawn.x + 3, room.spawn.z);
      expect(body.pose.x).toBeCloseTo(room.spawn.x + 3, 1);
      // The front desk stands across the room: straight through it is turned down.
      walk(2, room.spawn.x + 3, room.spawn.z + 4.5);
      expect(body.pose.z).toBeCloseTo(room.spawn.z, 1);
    });

    it('lets a body walk from the lobby through the office to a cell', async () => {
      const t = setup({});
      const a = await t.join('ada');
      const body = t.inner.players.get(a.id);
      if (!body) throw new Error('no player');
      at(t, a.id, entrance('police'));
      t.send(a.conn, { type: 'act', what: ACT.DOOR, arg: entrance('police') });
      const { x0, z0 } = INTERIORS.police.rect;
      let seq = 0;
      t.advance(800);
      // The office door, up the aisle to the far end, right along the corridor, in at a gate.
      for (const [x, z] of [
        [6.2, 5],
        [6.2, 16.8],
        [14, 16],
        [15.3, 16],
        [15.3, 10.5],
      ] as const) {
        const [fromX, fromZ] = [body.pose.x, body.pose.z];
        const steps = Math.ceil(Math.hypot(x0 + x - fromX, z0 + z - fromZ) / 2);
        for (let i = 1; i <= steps; i += 1) {
          t.advance(800);
          t.tick(1);
          seq += 1;
          t.send(a.conn, {
            type: 'state',
            seq,
            x: fromX + ((x0 + x - fromX) * i) / steps,
            y: 0,
            z: fromZ + ((z0 + z - fromZ) * i) / steps,
            vx: 0,
            vy: 0,
            vz: 0,
            yaw: 0,
            state: 1,
          });
        }
        expect(body.pose.x).toBeCloseTo(x0 + x, 1);
        expect(body.pose.z).toBeCloseTo(z0 + z, 1);
      }
    });

    it('holds no room a body can walk into, and no shooting in the safe ones', async () => {
      expect(INTERIORS.hospital.safe && INTERIORS.police.safe).toBe(true);
      expect(INTERIORS.vipers.safe).toBe(false);
      const t = setup({});
      const a = await t.join('ada');
      a.conn.take('correction');
      const room = INTERIORS.hospital.spawn;
      t.send(a.conn, {
        type: 'state',
        seq: 1,
        x: room.x,
        y: 0,
        z: room.z,
        vx: 0,
        vy: 0,
        vz: 0,
        yaw: 0,
        state: 0,
      });
      await settle();
      expect(interiorAt(t.inner.players.get(a.id)?.pose.x ?? 0, 0)).toBeNull();
    });
  });

  describe("the Station's garage", () => {
    const points = lockers;
    const liftOf = (service: string, room: string) =>
      points.findIndex(
        (p) => p.kind === 'lift' && p.service === service && interiorAt(p.x, p.z)?.id === room,
      );
    const liftUp = liftOf('police', 'police');
    const liftDown = liftOf('police', 'police_garage');
    const ramp = points.find((p) => p.kind === 'ramp' && p.service === 'police');
    const bays = FLOORS.police_garage.bays ?? [];
    type Car = {
      id: number;
      owner?: string;
      driver: number;
      pose: { x: number; y: number; z: number; yaw: number };
    };
    const cars = (t: ReturnType<typeof setup>) => [
      ...(t.world as unknown as { vehicles: Map<number, Car> }).vehicles.values(),
    ];
    const stand = (t: ReturnType<typeof setup>, id: number, at: { x: number; z: number }) =>
      Object.assign(t.inner.players.get(id)?.pose ?? {}, { x: at.x, z: at.z });
    const parked = (t: ReturnType<typeof setup>, bay: number, row = bays) => {
      const b = row[bay];
      const car = cars(t).find((c) => b && Math.hypot(c.pose.x - b.x, c.pose.z - b.z) < 1);
      if (!car) throw new Error('no car in that bay');
      return car;
    };

    it('takes police staff down and back up, and nobody else', async () => {
      const t = setup({ cop: { faction: 'police', rank: 2 } });
      const cop = await t.join('cop');
      const ada = await t.join('ada');
      const office = points[liftUp];
      const garage = points[liftDown];
      if (!office || !garage) throw new Error('no elevator');
      stand(t, ada.id, office);
      t.send(ada.conn, { type: 'act', what: ACT.DOOR, arg: liftUp });
      expect(interiorAt(t.inner.players.get(ada.id)?.pose.x ?? 0, office.z)?.id).toBe('police');
      expect(ada.conn.told().join()).toContain('Staff only');
      stand(t, cop.id, office);
      t.send(cop.conn, { type: 'act', what: ACT.DOOR, arg: liftUp });
      const down = t.inner.players.get(cop.id)?.pose;
      expect(interiorAt(down?.x ?? 0, down?.z ?? 0)?.id).toBe('police_garage');
      t.send(cop.conn, { type: 'act', what: ACT.DOOR, arg: liftDown });
      const up = t.inner.players.get(cop.id)?.pose;
      expect(interiorAt(up?.x ?? 0, up?.z ?? 0)?.id).toBe('police');
    });

    it('keeps cruisers for police on duty, and fills the bay again once one has gone', async () => {
      const t = setup({ cop: { faction: 'police', rank: 2 } });
      const cop = await t.join('cop');
      const car = parked(t, 0);
      stand(t, cop.id, { x: car.pose.x + 2, z: car.pose.z });
      t.send(cop.conn, { type: 'enter_vehicle', vehicle: car.id });
      expect(cop.conn.take('error').at(-1)?.message).toContain('police on duty');
      expect(car.driver).toBe(0xffff);
      await t.duty(cop);
      cop.conn.told();
      stand(t, cop.id, { x: car.pose.x + 2, z: car.pose.z });
      t.send(cop.conn, { type: 'enter_vehicle', vehicle: car.id });
      expect(car.driver).toBe(cop.id);
      expect(car.owner).toBe('cop');
      // Still in the bay: no second car on top of it.
      t.tick(TICK_HZ * 2);
      expect(cars(t).filter((c) => c.owner === 'police-pool')).toHaveLength(bays.length - 1);
      // Driven away, officer and all (no bay is left under either of them).
      for (const body of [car.pose, t.inner.players.get(cop.id)?.pose ?? car.pose]) body.z -= 12;
      t.tick(TICK_HZ * 2);
      expect(cars(t).filter((c) => c.owner === 'police-pool')).toHaveLength(bays.length);
    });

    it('brings the car up the ramp to the street, and off duty it goes back', async () => {
      const t = setup({ cop: { faction: 'police', rank: 2 } });
      const cop = await t.join('cop');
      await t.duty(cop);
      const car = parked(t, 3);
      stand(t, cop.id, { x: car.pose.x + 2, z: car.pose.z });
      t.send(cop.conn, { type: 'enter_vehicle', vehicle: car.id });
      if (!ramp) throw new Error('no ramp');
      Object.assign(car.pose, { x: ramp.x - 4, z: ramp.z });
      cop.conn.take('correction');
      t.tick(1);
      t.send(cop.conn, {
        type: 'state',
        seq: 1,
        x: ramp.x - 2,
        y: 0,
        z: ramp.z,
        vx: 5,
        vy: 0,
        vz: 0,
        yaw: Math.PI / 2,
        state: 0,
      });
      expect(interiorAt(car.pose.x, car.pose.z)).toBeNull();
      const door = points.find((p) => p.kind === 'entrance' && p.service === 'police');
      expect(Math.hypot(car.pose.x - (door?.x ?? 0), car.pose.z - (door?.z ?? 0))).toBeLessThan(25);
      expect(cop.conn.take('correction').at(-1)?.x).toBeCloseTo(car.pose.x);
      t.send(cop.conn, { type: 'exit_vehicle' });
      await t.duty(cop);
      expect(cars(t).some((c) => c.id === car.id)).toBe(false);
    });

    it('sends police to the garage when they ask for a car', async () => {
      const t = setup({ cop: { faction: 'police', rank: 2 } });
      const cop = await t.join('cop');
      await t.duty(cop);
      cop.conn.told();
      await t.say(cop.conn, '/vehicle');
      expect(cop.conn.told().join()).toContain('garage');
    });

    describe("and the Hospital's", () => {
      const ambulances = FLOORS.hospital_garage.bays ?? [];
      const ward = liftOf('hospital', 'hospital');
      const under = liftOf('hospital', 'hospital_garage');
      const exit = points.find((p) => p.kind === 'ramp' && p.service === 'hospital');

      it('takes medics down and back up, and nobody else', async () => {
        const t = setup({
          medic: { faction: 'medical', rank: 2 },
          cop: { faction: 'police', rank: 2 },
        });
        const medic = await t.join('medic');
        const cop = await t.join('cop');
        const up = points[ward];
        if (!up) throw new Error('no elevator');
        stand(t, cop.id, up);
        t.send(cop.conn, { type: 'act', what: ACT.DOOR, arg: ward });
        expect(cop.conn.told().join()).toContain('Staff only');
        stand(t, medic.id, up);
        t.send(medic.conn, { type: 'act', what: ACT.DOOR, arg: ward });
        const down = t.inner.players.get(medic.id)?.pose;
        expect(interiorAt(down?.x ?? 0, down?.z ?? 0)?.id).toBe('hospital_garage');
        t.send(medic.conn, { type: 'act', what: ACT.DOOR, arg: under });
        const back = t.inner.players.get(medic.id)?.pose;
        expect(interiorAt(back?.x ?? 0, back?.z ?? 0)?.id).toBe('hospital');
      });

      it('keeps ambulances for medics on duty, and refuses police', async () => {
        const t = setup({
          medic: { faction: 'medical', rank: 2 },
          cop: { faction: 'police', rank: 2 },
        });
        const medic = await t.join('medic');
        const cop = await t.join('cop');
        const car = parked(t, 0, ambulances);
        await t.duty(cop);
        stand(t, cop.id, { x: car.pose.x + 2, z: car.pose.z });
        t.send(cop.conn, { type: 'enter_vehicle', vehicle: car.id });
        expect(cop.conn.take('error').at(-1)?.message).toContain('EMS on duty');
        stand(t, medic.id, { x: car.pose.x + 2, z: car.pose.z });
        t.send(medic.conn, { type: 'enter_vehicle', vehicle: car.id });
        expect(medic.conn.take('error').at(-1)?.message).toContain('EMS on duty');
        expect(car.driver).toBe(0xffff);
        await t.duty(medic, 'hospital');
        stand(t, medic.id, { x: car.pose.x + 2, z: car.pose.z });
        t.send(medic.conn, { type: 'enter_vehicle', vehicle: car.id });
        expect(car.driver).toBe(medic.id);
        expect(car.owner).toBe('medic');
      });

      it('brings the ambulance up outside the Hospital, and off duty it goes back', async () => {
        const t = setup({ medic: { faction: 'medical', rank: 2 } });
        const medic = await t.join('medic');
        await t.duty(medic, 'hospital');
        const car = parked(t, 1, ambulances);
        stand(t, medic.id, { x: car.pose.x + 2, z: car.pose.z });
        t.send(medic.conn, { type: 'enter_vehicle', vehicle: car.id });
        if (!exit) throw new Error('no ramp');
        Object.assign(car.pose, { x: exit.x - 4, z: exit.z });
        t.tick(1);
        t.send(medic.conn, {
          type: 'state',
          seq: 1,
          x: exit.x - 2,
          y: 0,
          z: exit.z,
          vx: 5,
          vy: 0,
          vz: 0,
          yaw: Math.PI / 2,
          state: 0,
        });
        expect(interiorAt(car.pose.x, car.pose.z)).toBeNull();
        const door = points.find((p) => p.kind === 'entrance' && p.service === 'hospital');
        expect(Math.hypot(car.pose.x - (door?.x ?? 0), car.pose.z - (door?.z ?? 0))).toBeLessThan(
          25,
        );
        t.send(medic.conn, { type: 'exit_vehicle' });
        await t.duty(medic, 'hospital');
        expect(cars(t).some((c) => c.id === car.id)).toBe(false);
      });

      it('sends medics to the garage when they ask for an ambulance', async () => {
        const t = setup({ medic: { faction: 'medical', rank: 2 } });
        const medic = await t.join('medic');
        await t.duty(medic, 'hospital');
        medic.conn.told();
        await t.say(medic.conn, '/vehicle');
        expect(medic.conn.told().join()).toContain('garage');
      });
    });
  });

  describe('duty and the counter', () => {
    it('goes on duty only at the lockers', async () => {
      const t = setup({ cop: { faction: 'police', rank: 2 } });
      const cop = await t.join('cop');
      await t.say(cop.conn, '/duty');
      expect(cop.conn.told().join()).toContain('lockers in the Police Station');
      await t.duty(cop);
      expect(cop.conn.told().join()).toContain('On duty');
    });

    it('turns strangers away from the lockers', async () => {
      const t = setup({});
      const a = await t.join('ada');
      const i = lockers.findIndex((p) => p.kind === 'locker' && p.service === 'police');
      const p = lockers[i];
      Object.assign(t.inner.players.get(a.id)?.pose ?? {}, { x: p?.x, z: p?.z });
      t.send(a.conn, { type: 'act', what: ACT.LOCKER, arg: i });
      expect(a.conn.told().join()).toContain('Staff only');
    });

    it('shows the uniform to others', async () => {
      const t = setup({ doc: { faction: 'medical', rank: 2 } });
      const doc = await t.join('doc');
      const see = await t.join('ada');
      t.tick(30);
      see.conn.take('enter');
      await t.duty(doc, 'hospital');
      const again = see.conn.take('enter').find((m) => m.id === doc.id);
      expect((again?.faction ?? 0) & ON_DUTY_BIT).toBe(ON_DUTY_BIT);
    });
  });
});
