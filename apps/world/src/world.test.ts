import {
  ACT,
  decodeServerFrame,
  encodeClient,
  ERROR_CODE,
  FLAG,
  JOB_OP,
  MODE,
  NO_ENTITY,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@fr33world/protocol';
import { generateCity } from '@fr33world/city';
import { CLOCK_EPOCH, DAMAGE, FUEL, gameMinutesAt } from '@fr33world/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Conn } from './transport.ts';
import { FOOT_LIMITS, MoveValidator } from './validate.ts';
import { cleanChat, World } from './world.ts';

class FakeConn implements Conn {
  static next = 1;
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
    return this.inbox.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  clear() {
    this.inbox.length = 0;
  }
}

function setup(maxPlayers = 10, streetCars = true) {
  let clock = 1_000_000;
  const world = new World({ maxPlayers, streetCars, now: () => clock });
  const advance = (ms: number) => {
    clock += ms;
  };
  const send = (conn: Conn, m: ClientMessage) => world.message(conn, encodeClient(m));
  const join = (name: string) => {
    const conn = new FakeConn();
    world.open(conn);
    send(conn, { type: 'hello', version: PROTOCOL_VERSION, name, token: '' });
    const welcome = conn.take('welcome')[0];
    if (!welcome) throw new Error(`no welcome for ${name}: ${JSON.stringify(conn.inbox)}`);
    return { conn, id: welcome.you, spawn: welcome.spawn };
  };
  return { world, advance, send, join };
}

describe('sessions', () => {
  it('welcomes a player at a plaza spawn with the game clock', () => {
    const { join } = setup();
    const { conn, spawn } = join('Ada');
    const welcome = conn.inbox[0];
    expect(welcome?.type).toBe('welcome');
    if (welcome?.type !== 'welcome') return;
    expect(welcome.clock.rate).toBe(30);
    // Anchored on the server-time timeline (0 = world start), not on anyone's wall clock.
    expect(welcome.clock.realMs).toBe(0);
    expect(welcome.clock.gameMinutes).toBeCloseTo(gameMinutesAt(CLOCK_EPOCH, 1_000_000));
    expect(spawn.state).toBe(MODE.IDLE);
  });

  it('keeps the time of day across restarts', () => {
    const at = CLOCK_EPOCH.realMs + 3 * 86_400_000 + 1234;
    const first = new World({ now: () => at });
    const later = at + 7 * 60_000;
    const restarted = new World({ now: () => later });
    expect(restarted.gameMinutes()).toBeCloseTo(first.gameMinutes() + 7 * 30);
    expect(restarted.gameMinutes()).toBeCloseTo(gameMinutesAt(CLOCK_EPOCH, later));
  });

  it('refuses a wrong protocol version and a full server', () => {
    const { world, join } = setup(1);
    const old = new FakeConn();
    world.open(old);
    world.message(old, encodeClient({ type: 'hello', version: 99, name: 'x', token: '' }));
    expect(old.take('error')[0]?.code).toBe(ERROR_CODE.BAD_VERSION);
    expect(old.closed).toBe(true);

    join('First');
    const late = new FakeConn();
    world.open(late);
    world.message(
      late,
      encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: 'Second', token: '' }),
    );
    expect(late.take('error')[0]?.code).toBe(ERROR_CODE.SERVER_FULL);
  });

  it('drops connections that never say hello', () => {
    const { world, advance } = setup();
    const conn = new FakeConn();
    world.open(conn);
    advance(6000);
    world.step();
    expect(conn.closed).toBe(true);
  });
});

describe('message rate limit', () => {
  it('caps a flood at the burst, never throttles normal play, and drops persistent flooders', () => {
    const { world, send, join, advance } = setup();
    const calm = join('Calm');
    world.stats();
    // Normal play: 21 messages a second for 10 seconds.
    for (let t = 0; t < 10; t += 1) {
      for (let i = 0; i < 21; i += 1) send(calm.conn, { type: 'exit_vehicle' });
      advance(1000);
    }
    expect(world.stats().dropped).toBe(0);
    expect(calm.conn.closed).toBe(false);

    const flood = join('Flood');
    for (let i = 0; i < 200; i += 1) send(flood.conn, { type: 'exit_vehicle' });
    // The burst allowance (120) goes through; the rest is dropped.
    expect(world.stats().dropped).toBe(80);
    expect(flood.conn.closed).toBe(false);
    for (let i = 0; i < 400; i += 1) send(flood.conn, { type: 'exit_vehicle' });
    expect(flood.conn.closed).toBe(true);
    expect(flood.conn.take('error')[0]?.message).toBe('Too many messages');
    expect(calm.conn.closed).toBe(false);
  });
});

describe('movement validation', () => {
  it('accepts a legal run and corrects a speed hack', () => {
    const { world, advance, send, join } = setup();
    const { conn, spawn } = join('Runner');
    advance(50);
    send(conn, { type: 'state', seq: 1, ...spawn, x: spawn.x + 0.3, state: MODE.RUN });
    expect(conn.take('correction')).toHaveLength(0);

    advance(50);
    send(conn, { type: 'state', seq: 2, ...spawn, x: spawn.x + 40, state: MODE.RUN });
    const [correction] = conn.take('correction');
    expect(correction?.x).toBeCloseTo(spawn.x + 0.3, 1);
    expect(world.stats().corrections).toBe(1);
  });

  it('rejects walking into a building, leaving the city, into the sea, and flying', () => {
    const { world } = setup();
    const b = world.city.buildings[0];
    if (!b) throw new Error('no buildings');
    const v = new MoveValidator(world.collision, world.city.bounds, world.heights);
    v.reset(0);
    const outside = { x: b.x - b.w / 2 - 1, y: 0, z: b.z };
    expect(v.check(outside, { ...outside, x: outside.x + 2 }, FOOT_LIMITS, 1000)).toBe('wall');
    expect(v.check(outside, { ...outside, x: outside.x - 0.5 }, FOOT_LIMITS, 1100)).toBe('ok');
    expect(v.check(outside, { ...outside, y: 20 }, FOOT_LIMITS, 1200)).toBe('height');
    const edge = { x: world.city.bounds.x1 - 0.2, y: 0, z: 0 };
    expect(v.check(edge, { ...edge, x: edge.x + 1 }, FOOT_LIMITS, 1300)).toBe('bounds');
    // From the beach into the Pacific beside the pier (the coast is near x = -1265 there).
    const beach = { x: -1255, y: 0, z: -40 };
    expect(v.check(beach, { ...beach, x: -1262 }, FOOT_LIMITS, 1400)).toBe('ok');
    expect(v.check(beach, { ...beach, x: -1268 }, FOOT_LIMITS, 1500)).toBe('bounds');
  });

  it('lets bodies out along the pier but not off its side into the sea', () => {
    const { world } = setup();
    const v = new MoveValidator(world.collision, world.city.bounds, world.heights);
    v.reset(0);
    const deck = { x: -1262, y: 0.15, z: 0 };
    expect(v.check(deck, { ...deck, x: -1268 }, FOOT_LIMITS, 1000)).toBe('ok');
    const out = { x: -1300, y: 0.15, z: 8 };
    expect(v.check(out, { ...out, z: 7 }, FOOT_LIMITS, 2000)).toBe('ok');
    expect(v.check(out, { ...out, z: 10 }, FOOT_LIMITS, 3000)).toBe('bounds');
    // The Ferris wheel's legs are solid.
    const { wheel } = world.city.landmarks;
    const leg = { x: wheel.x + 2.5, y: 0.15, z: wheel.z + 14 };
    expect(v.check({ ...leg, z: leg.z - 2 }, leg, FOOT_LIMITS, 4000)).toBe('wall');
  });

  it('checks heights against the ground: bridges, the river channel, the mountains', () => {
    const { world } = setup();
    const v = new MoveValidator(world.collision, world.city.bounds, world.heights);
    v.reset(0);
    const bridge = world.city.bridges[1];
    if (!bridge) throw new Error('no bridge');
    const mid = (bridge.x0 + bridge.x1) / 2;
    const onDeck = { x: mid, y: 0.15, z: bridge.z + bridge.carriage / 2 };
    expect(v.check({ ...onDeck, x: mid - 1 }, onDeck, FOOT_LIMITS, 1000)).toBe('ok');
    // Down in the channel beside the bridge, and not hovering over it.
    const channel = { x: mid, y: -6, z: bridge.z + bridge.half + 8 };
    expect(v.check({ ...channel, x: mid - 1 }, channel, FOOT_LIMITS, 2000)).toBe('ok');
    expect(v.check(channel, { ...channel, y: 2 }, FOOT_LIMITS, 3000)).toBe('height');
    // On a mountainside: near the ground is fine, under it or far above it is not.
    const slope = { x: -400, y: 0, z: -1200 };
    const ground = world.heights(slope.x, slope.z).ground;
    expect(ground).toBeGreaterThan(20);
    expect(
      v.check({ ...slope, x: -401, y: ground }, { ...slope, y: ground }, FOOT_LIMITS, 4000),
    ).toBe('ok');
    expect(v.check(slope, { ...slope, y: ground - 5 }, FOOT_LIMITS, 5000)).toBe('height');
    expect(v.check(slope, { ...slope, y: ground + 12 }, FOOT_LIMITS, 6000)).toBe('height');
  });

  it('lets jittery but honest reports through', () => {
    const { world } = setup();
    const v = new MoveValidator(world.collision, world.city.bounds, world.heights);
    const spot = world.city.playerSpawns[0];
    if (!spot) throw new Error('no spawn');
    v.reset(0);
    let x = spot.x;
    // 300 ms stall, then six 50 ms reports arrive at once at running speed.
    for (let i = 0; i < 6; i += 1) {
      const next = x + 6 * 0.05;
      expect(v.check({ x, y: 0, z: spot.z }, { x: next, y: 0, z: spot.z }, FOOT_LIMITS, 300)).toBe(
        'ok',
      );
      x = next;
    }
  });

  it('ignores stale sequence numbers and never lets clients claim SEATED', () => {
    const { advance, send, join, world } = setup();
    const a = join('A');
    const b = join('B');
    advance(100);
    send(a.conn, { type: 'state', seq: 5, ...a.spawn, x: a.spawn.x + 0.5, state: MODE.SEATED });
    send(a.conn, { type: 'state', seq: 4, ...a.spawn, x: a.spawn.x + 0.1 });
    world.step();
    const seen = b.conn
      .take('snapshot')
      .flatMap((s) => s.entities)
      .find((e) => e.id === a.id);
    expect(seen?.x).toBeCloseTo(a.spawn.x + 0.5, 1);
    expect(seen?.state).toBe(MODE.IDLE);
  });
});

describe('interest management', () => {
  it('introduces nearby players and streams their movement', () => {
    const { world, advance, send, join } = setup();
    const a = join('A');
    const b = join('B');
    world.step();
    expect(a.conn.take('enter').some((e) => e.id === b.id && e.name === 'B')).toBe(true);
    a.conn.clear();
    advance(50);
    send(b.conn, { type: 'state', seq: 1, ...b.spawn, x: b.spawn.x + 0.2, state: MODE.WALK });
    world.step();
    const update = a.conn
      .take('snapshot')
      .flatMap((s) => s.entities)
      .find((e) => e.id === b.id);
    expect(update?.state).toBe(MODE.WALK);
  });

  it('does not resend unchanged entities until the keepalive', () => {
    const { world, join } = setup();
    const a = join('A');
    join('B');
    world.step();
    a.conn.clear();
    for (let i = 0; i < 5; i += 1) world.step();
    expect(a.conn.take('snapshot')).toHaveLength(0);
    for (let i = 0; i < 30; i += 1) world.step();
    expect(a.conn.take('snapshot').length).toBeGreaterThan(0);
  });

  it('sends leave when a player disconnects', () => {
    const { world, join } = setup();
    const a = join('A');
    const b = join('B');
    world.step();
    world.close(b.conn);
    for (let i = 0; i < 3; i += 1) world.step();
    expect(a.conn.take('leave').map((l) => l.id)).toContain(b.id);
  });

  it('caps a crowd at VIEW_MAX entities per client', () => {
    const { world, join } = setup(300);
    const players = Array.from({ length: 200 }, (_, i) => join(`P${i}`));
    world.step();
    const first = players[0];
    if (!first) throw new Error('no players');
    const seen = new Set(first.conn.take('enter').map((e) => e.id));
    expect(seen.size).toBeLessThanOrEqual(128);
  });
});

describe('vehicles', () => {
  it('leaves no free cars at the kerbs for newcomers', () => {
    const { world, join } = setup(10, false);
    const a = join('Newcomer');
    world.step();
    expect(a.conn.take('enter').filter((e) => e.kind === 1)).toEqual([]);
  });

  it('grants a nearby free seat, refuses a far one, and exits beside the car', () => {
    const { world, advance, send, join } = setup();
    const a = join('Driver');
    world.step();
    const cars = a.conn.take('enter').filter((e) => e.kind === 1);
    expect(cars.length).toBeGreaterThan(0);

    // Vehicles take ids in spawn order, so the lowest id sits at the first vehicle spawn.
    const spawn = world.city.vehicleSpawns[0];
    const car = cars.sort((x, y) => x.id - y.id)[0];
    if (!spawn || !car) throw new Error('no cars');
    send(a.conn, { type: 'enter_vehicle', vehicle: car.id });
    expect(a.conn.take('error')[0]?.code).toBe(ERROR_CODE.SEAT_DENIED);

    // Run to the car's side in legal 50 ms steps, then get in.
    const target = { x: spawn.x, z: spawn.z - 2 };
    let at = { x: a.spawn.x, z: a.spawn.z };
    let seq = 1;
    while (Math.hypot(target.x - at.x, target.z - at.z) > 0.01) {
      const dx = target.x - at.x;
      const dz = target.z - at.z;
      const step = Math.min(1, 0.3 / Math.hypot(dx, dz));
      at = { x: at.x + dx * step, z: at.z + dz * step };
      advance(50);
      send(a.conn, { type: 'state', seq: seq++, ...a.spawn, x: at.x, z: at.z, state: MODE.RUN });
    }
    expect(a.conn.take('correction')).toHaveLength(0);

    send(a.conn, { type: 'enter_vehicle', vehicle: car.id });
    const seat = a.conn.take('seat').at(-1);
    expect(seat?.driver).toBe(a.id);

    send(a.conn, { type: 'exit_vehicle' });
    expect(a.conn.take('seat').at(-1)?.driver).toBe(NO_ENTITY);
    expect(a.conn.take('correction')).toHaveLength(1);
  });

  it('carries up to three passengers, who move with the car and can be put out', () => {
    const { world, advance, send, join } = setup();
    const inner = world as unknown as {
      players: Map<number, { pose: { x: number; y: number; z: number } }>;
      vehicles: Map<
        number,
        { model: number; pose: { x: number; y: number; z: number; vx: number; vz: number } }
      >;
    };
    const driver = join('Driver');
    const riders = ['Ann', 'Ben', 'Cal', 'Dee'].map((n) => join(n));
    world.step();
    const car = [...inner.vehicles.entries()][0];
    if (!car) throw new Error('no cars');
    const [id, v] = car;
    v.model = 0;
    const beside = (p: number) =>
      Object.assign(inner.players.get(p)?.pose ?? {}, {
        x: v.pose.x + 1.5,
        y: v.pose.y,
        z: v.pose.z,
      });
    const board = (p: (typeof riders)[number]) => {
      beside(p.id);
      send(p.conn, { type: 'act', what: ACT.RIDE, arg: id });
    };

    // Nobody driving: nobody to ride with.
    board(riders[0]!);
    expect(riders[0]!.conn.take('error').at(-1)?.message).toMatch(/Nobody to ride/);
    beside(driver.id);
    send(driver.conn, { type: 'enter_vehicle', vehicle: id });

    // Moving: wait. Stopped: in, each in their own seat, and the fourth finds it full.
    v.pose.vx = 10;
    advance(500);
    board(riders[0]!);
    expect(riders[0]!.conn.take('error').at(-1)?.message).toMatch(/Wait for it/);
    v.pose.vx = 0;
    advance(500);
    for (const r of riders) {
      board(r);
      advance(500);
    }
    const said = driver.conn.take('passenger');
    const seats = riders.slice(0, 3).map((r) => said.find((m) => m.player === r.id));
    expect(seats.map((m) => m?.seat)).toEqual([1, 2, 3]);
    expect(seats.every((m) => m?.vehicle === id)).toBe(true);
    expect(riders[3]!.conn.take('error').at(-1)?.message).toMatch(/full/);

    // What a passenger reports moves nothing; the car moves them.
    advance(50);
    send(riders[0]!.conn, {
      type: 'state',
      seq: 1,
      ...v.pose,
      vy: 0,
      yaw: 0,
      x: 0,
      z: 0,
      state: 0,
    });
    expect(inner.players.get(riders[0]!.id)?.pose.x).toBeCloseTo(v.pose.x);
    const to = v.pose.x + 0.5;
    send(driver.conn, { type: 'state', seq: 1, ...v.pose, vy: 0, yaw: 0, x: to, state: 0 });
    expect(v.pose.x).toBeCloseTo(to);
    expect(inner.players.get(riders[1]!.id)?.pose.x).toBeCloseTo(to);

    // The car stays in a passenger's view, though a driver's own car leaves theirs.
    riders[1]!.conn.take('leave');
    advance(500);
    world.step();
    expect(riders[1]!.conn.take('leave').map((m) => m.id)).not.toContain(id);

    // A passenger gets out; the car keeps its driver.
    send(riders[0]!.conn, { type: 'exit_vehicle' });
    expect(riders[0]!.conn.take('passenger').at(-1)).toMatchObject({ seat: 0, vehicle: NO_ENTITY });
    expect(driver.conn.take('seat').filter((m) => m.driver === NO_ENTITY)).toHaveLength(0);
    expect(riders[0]!.conn.take('correction')).toHaveLength(1);
  });
});

describe('proximity chat', () => {
  it('reaches players nearby and echoes to the speaker, tidied', () => {
    const { world, send, join } = setup();
    const a = join('A');
    const b = join('B');
    world.step();
    send(a.conn, { type: 'chat', text: '  hey\u0007   there\n ' });
    for (const p of [a, b]) {
      expect(p.conn.take('chat')).toEqual([{ type: 'chat', from: a.id, text: 'hey there' }]);
    }
    // Nothing to say: nothing sent.
    send(a.conn, { type: 'chat', text: ' \u200b ' });
    expect(b.conn.take('chat')).toHaveLength(1);
  });

  it('allows a short burst, then one line every second and a half', () => {
    const { world, advance, send, join } = setup();
    const a = join('A');
    const b = join('B');
    world.step();
    for (let i = 0; i < 10; i += 1) send(a.conn, { type: 'chat', text: `line ${i}` });
    expect(b.conn.take('chat')).toHaveLength(4);
    b.conn.clear();
    advance(1600);
    for (let i = 0; i < 3; i += 1) send(a.conn, { type: 'chat', text: `more ${i}` });
    expect(b.conn.take('chat')).toHaveLength(1);
  });

  it('caps a line at 140 characters, counting emoji as one', () => {
    expect([...cleanChat('😀'.repeat(200))]).toHaveLength(140);
    expect(cleanChat('a'.repeat(300))).toHaveLength(140);
  });
});

describe('emotes', () => {
  it('show to players around, not to the emoter, and not from nowhere', () => {
    const { world, advance, send, join } = setup();
    const a = join('A');
    const b = join('B');
    world.step();
    send(a.conn, { type: 'emote', emote: 1 });
    expect(b.conn.take('emote')).toEqual([{ type: 'emote', from: a.id, emote: 1 }]);
    expect(a.conn.take('emote')).toHaveLength(0);
    b.conn.clear();
    // No such emote; and not twice within half a second.
    advance(600);
    send(a.conn, { type: 'emote', emote: 200 });
    send(a.conn, { type: 'emote', emote: 2 });
    send(a.conn, { type: 'emote', emote: 3 });
    expect(b.conn.take('emote')).toEqual([{ type: 'emote', from: a.id, emote: 2 }]);
  });
});

describe('jobs through the world', () => {
  it('starts a courier shift at the depot once the player has walked there', () => {
    const { advance, send, join } = setup();
    const city = generateCity();
    const depot = city.points.findIndex((q) => q.kind === 'depot');
    const d = city.points[depot] as { x: number; z: number };
    // The seventh spawn is on the plaza's west side, a few metres from the lockers.
    let p = join('P0');
    for (let i = 1; i < 7; i += 1) p = join(`P${i}`);
    // Too far: refused.
    send(p.conn, { type: 'job', op: JOB_OP.START, point: depot });
    expect(p.conn.take('chat').at(-1)?.text).toMatch(/closer/);
    // Walk over (a few steps at a walk).
    let x = p.spawn.x;
    let seq = 1;
    while (Math.abs(x - d.x) > 0.3) {
      advance(200);
      x += Math.sign(d.x - x) * Math.min(0.3, Math.abs(d.x - x));
      send(p.conn, { type: 'state', seq: seq++, ...p.spawn, x, z: d.z, state: MODE.WALK });
    }
    expect(p.conn.take('correction')).toHaveLength(0);
    advance(400);
    send(p.conn, { type: 'job', op: JOB_OP.START, point: depot });
    const view = JSON.parse(p.conn.take('job').at(-1)?.state ?? 'null') as {
      job: string;
      step: string;
      endsAt: number;
    };
    expect(view).toMatchObject({
      job: 'courier',
      step: expect.stringMatching(/Collect/) as unknown,
    });
    // The shift's end is on the server-time timeline (what the HUD counts down against), so
    // a 25-minute route ends about 25 minutes after the world started (this world's clock
    // starts at 1,000,000 ms, which the old, wall-clock value carried on top).
    expect(view.endsAt).toBeGreaterThan(25 * 60_000);
    expect(view.endsAt).toBeLessThan(27 * 60_000);
    advance(400);
    send(p.conn, { type: 'job', op: JOB_OP.USE, point: depot });
    const next = JSON.parse(p.conn.take('job').at(-1)?.state ?? 'null') as { step: string };
    expect(next.step).toMatch(/Deliver to/);
    advance(400);
    send(p.conn, { type: 'job', op: JOB_OP.QUIT, point: 0 });
    expect(p.conn.take('job').at(-1)?.state).toBe('');
  });
});

describe('your own car at a car park', () => {
  it('comes to a free bay, only its owner can drive it, and goes when they leave', async () => {
    const { world, advance, send, join } = setup();
    const city = generateCity();
    const lotPoint = city.points.findIndex((q) => q.kind === 'parking');
    const entrance = city.points[lotPoint] as { x: number; z: number };
    const owner = join('Owner');
    const other = join('Other');
    // Stand them at the car park (as if they'd walked there).
    type Inner = {
      players: Map<number, { pose: { x: number; z: number } }>;
      vehicles: Map<number, { owner?: string; pose: { x: number; z: number } }>;
    };
    const inner = world as unknown as Inner;
    for (const id of [owner.id, other.id])
      Object.assign(inner.players.get(id)?.pose ?? {}, entrance);
    advance(5000);
    send(owner.conn, { type: 'job', op: JOB_OP.START, point: lotPoint });
    await new Promise((r) => setTimeout(r, 0));
    expect(owner.conn.take('chat').at(-1)?.text).toMatch(/Your Compact is waiting in bay \d+/);
    // (Not one on show at the dealership.)
    const car = [...inner.vehicles.entries()].find(([, v]) => v.owner && v.owner !== 'dealer');
    expect(car).toBeDefined();
    const [carId, v] = car as [number, { pose: { x: number; z: number } }];
    // Someone else can't take it; its owner can.
    Object.assign(inner.players.get(other.id)?.pose ?? {}, { x: v.pose.x + 1, z: v.pose.z });
    send(other.conn, { type: 'enter_vehicle', vehicle: carId });
    expect(other.conn.take('error').at(-1)?.message).toMatch(/Owner's car/);
    advance(500);
    Object.assign(inner.players.get(owner.id)?.pose ?? {}, { x: v.pose.x + 1, z: v.pose.z });
    send(owner.conn, { type: 'enter_vehicle', vehicle: carId });
    expect(owner.conn.take('seat').at(-1)).toMatchObject({ vehicle: carId, driver: owner.id });
    send(owner.conn, { type: 'exit_vehicle' });
    // Gone with its owner (anonymous players leave at once).
    world.close(owner.conn);
    expect(inner.vehicles.has(carId)).toBe(false);
  });
});

describe('fuel and damage', () => {
  // Damage is off for launch; these check it as it'll be when it's back.
  const damage = DAMAGE as { enabled: boolean };
  let was = false;
  beforeEach(() => {
    was = damage.enabled;
    damage.enabled = true;
  });
  afterEach(() => {
    damage.enabled = was;
  });

  type Car = {
    id: number;
    driver: number;
    fuel: number;
    health: number;
    idleSince: number;
    spawn?: number;
    pose: { x: number; y: number; z: number; yaw: number; state: number };
  };
  type Inner = {
    players: Map<number, { pose: { x: number; z: number } }>;
    vehicles: Map<number, Car>;
  };

  /** A player sat in the first street car, and a way to drive it along +x. */
  function inCar() {
    const t = setup();
    const inner = t.world as unknown as Inner;
    const car = [...inner.vehicles.values()].find((v) => v.spawn === 0) as Car;
    const me = t.join('Driver');
    Object.assign(inner.players.get(me.id)?.pose ?? {}, { x: car.pose.x, z: car.pose.z + 1.5 });
    t.send(me.conn, { type: 'enter_vehicle', vehicle: car.id });
    expect(me.conn.take('seat').at(-1)?.driver).toBe(me.id);
    let seq = 1;
    const at = { x: car.pose.x, z: car.pose.z };
    const report = (dx: number, speed: number) => {
      at.x += dx;
      t.advance(50);
      t.send(me.conn, {
        type: 'state',
        seq: seq++,
        x: at.x,
        y: car.pose.y,
        z: at.z,
        yaw: Math.PI / 2,
        vx: speed,
        vy: 0,
        vz: 0,
        state: 0,
      });
    };
    return { ...t, inner, car, me, report };
  }

  it('burns fuel by the distance driven, and tells the driver', () => {
    const { car, me, report } = inCar();
    expect(me.conn.take('car').at(-1)).toMatchObject({ vehicle: car.id, fuel: 1, health: 1 });
    for (let i = 0; i < 60; i += 1) report(0.5, 10);
    expect(me.conn.take('correction')).toHaveLength(0);
    expect(car.fuel).toBeCloseTo(1 - 30 / FUEL.range, 5);
    expect(car.health).toBe(1);
  });

  it('a crash costs condition and makes the car smoke for everyone; a big one wrecks it', () => {
    const { car, me, report } = inCar();
    for (let i = 0; i < 4; i += 1) report(1, 20);
    // From 20 m/s to a standstill in one report: a wall.
    report(0.2, 0);
    expect(car.health).toBeLessThan(0.45);
    expect(car.health).toBeGreaterThan(0);
    expect(car.pose.state & FLAG.DAMAGED).toBeTruthy();
    expect(me.conn.take('car').at(-1)?.health).toBeCloseTo(car.health, 1);
    // Braking hard is not a crash.
    const before = car.health;
    for (let v = 20; v >= 0; v -= 0.5) report(0.4, v);
    expect(car.health).toBe(before);
    for (let i = 0; i < 4; i += 1) report(1.4, 28);
    report(0.1, 0);
    expect(car.health).toBe(0);
    expect(car.pose.state & FLAG.WRECKED).toBeTruthy();
  });

  it('passes the horn and the lights on to everyone, and keeps the smoke the server’s', () => {
    const { car, report, send, me } = inCar();
    report(0.5, 10);
    send(me.conn, {
      type: 'state',
      seq: 999,
      x: car.pose.x + 0.5,
      y: car.pose.y,
      z: car.pose.z,
      yaw: Math.PI / 2,
      vx: 10,
      vy: 0,
      vz: 0,
      // A driver claiming its own car is wrecked isn't believed.
      state: FLAG.HORN | FLAG.LIGHTS | FLAG.WRECKED,
    });
    expect(car.pose.state & FLAG.HORN).toBeTruthy();
    expect(car.pose.state & FLAG.LIGHTS).toBeTruthy();
    expect(car.pose.state & FLAG.WRECKED).toBe(0);
  });

  it('puts a wrecked or empty street car back at its spawn after a while, filled and fixed', () => {
    const { world, inner, car, me, report, send, advance } = inCar();
    for (let i = 0; i < 10; i += 1) report(1, 20);
    send(me.conn, { type: 'exit_vehicle' });
    car.health = 0;
    const spawn = world.city.vehicleSpawns[0] as { x: number; z: number };
    // Out of the way of its spawn.
    Object.assign(inner.players.get(me.id)?.pose ?? {}, { x: spawn.x + 30, z: spawn.z + 10 });
    advance(60_000);
    for (let i = 0; i < 40; i += 1) world.step();
    expect(car.pose.x).not.toBeCloseTo(spawn.x, 0);
    advance(200_000);
    for (let i = 0; i < 40; i += 1) world.step();
    expect(car).toMatchObject({ fuel: 1, health: 1 });
    expect(car.pose.x).toBeCloseTo(spawn.x, 3);
    expect(car.pose.state & (FLAG.DAMAGED | FLAG.WRECKED)).toBe(0);
  });
});
