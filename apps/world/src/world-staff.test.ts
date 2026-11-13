import {
  type ClientMessage,
  decodeServerFrame,
  encodeClient,
  ERROR_CODE,
  JOB_OP,
  NO_ENTITY,
  SERVICE,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@fr33world/protocol';
import { DAMAGE, DEALER_MODELS, fuelCost, repairCost, TAXI } from '@fr33world/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, parseCents } from './commands.ts';
import type { Conn } from './transport.ts';
import { type Identity, World, type WorldOptions } from './world.ts';

class FakeConn implements Conn {
  static next = 9000;
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
  /** What the server said to this player (command replies and calls), not other players. */
  told(): string[] {
    return this.take('chat')
      .filter((m) => m.from === NO_ENTITY)
      .map((m) => m.text);
  }
  clear() {
    this.inbox.length = 0;
  }
}

/** Accounts by token: "<account>" logs in as that person. */
const PEOPLE: Record<string, Identity> = {
  boss: { account: 'boss', name: 'Ada Byron', staff: { role: 'super', permissions: [] } },
  mod: {
    account: 'mod',
    name: 'Jon Mod',
    staff: { role: 'admin', permissions: ['teleport', 'kick', 'mute'] },
  },
  judge: { account: 'judge', name: 'Kim Judge', staff: { role: 'admin', permissions: ['ban'] } },
  banker: {
    account: 'banker',
    name: 'Bo Banker',
    staff: { role: 'admin', permissions: ['money'] },
  },
  ivy: { account: 'ivy', name: 'Ivy Lane' },
  vet: { account: 'vet', name: 'Val Vet', xp: 5_000 },
  sam: { account: 'sam', name: 'Sam Lane' },
};
const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(staffApi?: WorldOptions['staffApi']) {
  let clock = 1_000_000;
  const world = new World({
    now: () => clock,
    authenticate: (token) => Promise.resolve(PEOPLE[token] ?? null),
    // Saved job shifts, places and what they carry (loaded on joining) aren't what these count.
    staffApi:
      staffApi &&
      ((path, body) =>
        path.startsWith('jobs/') || path.startsWith('place')
          ? Promise.resolve({ saved: null })
          : path === 'arms'
            ? Promise.resolve({ arms: { licence: false, weapons: [], rounds: {} } })
            : path === 'faction'
              ? Promise.resolve({ membership: null })
              : staffApi(path, body)),
  });
  const send = (conn: Conn, m: ClientMessage) => world.message(conn, encodeClient(m));
  const join = async (token: string) => {
    const conn = new FakeConn();
    world.open(conn);
    send(conn, { type: 'hello', version: PROTOCOL_VERSION, name: 'x', token });
    await settle();
    const welcome = conn.take('welcome')[0];
    if (!welcome) throw new Error(`no welcome for ${token}: ${JSON.stringify(conn.inbox)}`);
    conn.clear();
    return { conn, id: welcome.you };
  };
  const say = async (conn: FakeConn, text: string) => {
    clock += 2000;
    send(conn, { type: 'chat', text });
    await settle();
  };
  return { world, join, say, advance: (ms: number) => (clock += ms) };
}

describe('chat commands', () => {
  it('splits names in quotes or not', () => {
    expect(parse('/ban "Ivy Lane" 24 spam bots')).toEqual({
      name: 'ban',
      args: ['Ivy Lane', '24', 'spam', 'bots'],
    });
    expect(parse('/GOTO Ivy Lane')).toEqual({ name: 'goto', args: ['Ivy', 'Lane'] });
    // A phone's keyboard types curly quotes.
    expect(parse('/money \u201CDavid Horjet\u201D +1000000 testing')).toEqual({
      name: 'money',
      args: ['David Horjet', '+1000000', 'testing'],
    });
  });

  it('/help tells the staff online where the player is, once a minute', async () => {
    const { join, say } = setup();
    const mod = await join('mod');
    const ivy = await join('ivy');
    await say(ivy.conn, '/help stuck in a wall');
    expect(mod.conn.told()[0]).toMatch(
      /Ivy Lane needs help in .+: stuck in a wall\. \/goto Ivy Lane/,
    );
    expect(ivy.conn.told()).toEqual(['Help is on the way: 1 admin told.']);
    // Not chat: nobody hears it as a line said.
    expect(mod.conn.take('chat').filter((m) => m.from !== NO_ENTITY)).toHaveLength(0);
    ivy.conn.clear();
    await say(ivy.conn, '/help');
    expect(ivy.conn.told()[0]).toMatch(/You can ask for help again in \d+ s/);
  });

  it('keeps staff commands from players, and each admin to their powers', async () => {
    const { join, say } = setup();
    const mod = await join('mod');
    const ivy = await join('ivy');
    await say(ivy.conn, '/kick Jon Mod');
    expect(ivy.conn.told()).toEqual(['Unknown command /kick. /commands lists yours.']);
    expect(mod.conn.closed).toBe(false);
    await say(mod.conn, '/announce hi all');
    expect(mod.conn.told()).toEqual(['Unknown command /announce. /commands lists yours.']);
    mod.conn.clear();
    await say(mod.conn, '/commands');
    const list = mod.conn.told().join('\n');
    expect(list).toContain('/bring');
    expect(list).toContain('/kick');
    expect(list).not.toContain('/ban');
    expect(list).not.toContain('/admin');
  });

  it('/bring moves the player beside the admin, telling their client', async () => {
    const { world, join, say } = setup();
    const mod = await join('mod');
    const ivy = await join('ivy');
    await say(mod.conn, '/tp 100 100');
    await say(mod.conn, '/bring ivy');
    const fix = ivy.conn.take('correction').at(-1);
    expect(fix).toBeDefined();
    expect(Math.hypot((fix?.x ?? 0) - 100, (fix?.z ?? 0) - 100)).toBeLessThan(3);
    expect(world.playerCount).toBe(2);
  });

  it('/kick removes the player at once (no ghost), and /mute stops their chat', async () => {
    const { world, join, say } = setup();
    const mod = await join('mod');
    const ivy = await join('ivy');
    const sam = await join('sam');
    await say(mod.conn, '/mute Sam Lane 5');
    sam.conn.clear();
    ivy.conn.clear();
    await say(sam.conn, 'hello?');
    expect(ivy.conn.take('chat')).toHaveLength(0);
    expect(sam.conn.told()[0]).toMatch(/muted for 5 more min/);
    await say(mod.conn, '/kick Ivy Lane spamming');
    expect(ivy.conn.closed).toBe(true);
    expect(ivy.conn.take('error')[0]).toMatchObject({ code: ERROR_CODE.KICKED });
    world.close(ivy.conn);
    expect(world.playerCount).toBe(2);
  });

  it('/ban goes through the API and keeps the account out of this server', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const { world, join, say } = setup((path, body) => {
      calls.push([path, body]);
      return Promise.resolve({ name: 'Ivy Lane', account: 'ivy', until: null });
    });
    const mod = await join('judge');
    const ivy = await join('ivy');
    await say(mod.conn, '/ban Ivy Lane 24 cheating');
    expect(calls[0]).toEqual([
      'ban',
      { name: 'Ivy Lane', hours: 24, reason: 'cheating', actor: 'judge' },
    ]);
    expect(ivy.conn.closed).toBe(true);
    const back = new FakeConn();
    world.open(back);
    world.message(
      back,
      encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: 'x', token: 'ivy' }),
    );
    await settle();
    expect(back.take('error')[0]).toMatchObject({ code: ERROR_CODE.KICKED });
    await say(mod.conn, '/unban "Ivy Lane"');
    expect(mod.conn.told().at(-1)).toBe('Ivy Lane can play again.');
    await join('ivy');
  });

  it('only the super admin makes admins', async () => {
    const calls: Record<string, unknown>[] = [];
    const { join, say } = setup((_path, body) => {
      calls.push(body);
      return Promise.resolve({ name: 'Sam Lane', permissions: ['kick', 'teleport'] });
    });
    const boss = await join('boss');
    await say(boss.conn, '/admin add "Sam Lane" kick,teleport');
    expect(calls).toEqual([{ name: 'Sam Lane', permissions: ['kick', 'teleport'], actor: 'boss' }]);
    expect(boss.conn.told().at(-1)).toMatch(/Sam Lane is an admin: kick, teleport/);
  });

  it('reads amounts for /money', () => {
    expect(parseCents('500')).toBe(50_000);
    expect(parseCents('+1,250.5')).toBe(125_050);
    expect(parseCents('-$20')).toBe(-2_000);
    expect(parseCents('ten')).toBeNaN();
    expect(parseCents('1.234')).toBeNaN();
  });

  it('/money corrects through the API with a reason, and tells the player', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const { join, say } = setup((path, body) => {
      calls.push([path, body]);
      return Promise.resolve({ name: 'Ivy Lane', balance: 75_000 });
    });
    const banker = await join('banker');
    const ivy = await join('ivy');
    await say(banker.conn, '/money "Ivy Lane" +250 refund for a lost car');
    expect(calls).toEqual([
      [
        'money',
        { name: 'Ivy Lane', cents: 25_000, reason: 'refund for a lost car', actor: 'banker' },
      ],
    ]);
    expect(banker.conn.told().at(-1)).toBe('Ivy Lane: $250 done. Balance $750.');
    expect(ivy.conn.told().at(-1)).toBe('An admin added $250: refund for a lost car');
    // Without the money power: no such command.
    await say(ivy.conn, '/money "Ivy Lane" +1000000 free money');
    expect(calls).toHaveLength(1);
  });
});

describe('car parks', () => {
  it('brings the car the player picked from their garage, one out at a time', async () => {
    // The API's ids are bigserials: they arrive as strings.
    const cars = [
      { id: '5', model: 1, colour: 0, name: 'Compact' },
      { id: '9', model: 0, colour: 0, name: 'Sedan' },
    ];
    const { world, join, advance } = setup((path) =>
      Promise.resolve(path === 'garage' ? { cars } : {}),
    );
    const ivy = await join('ivy');
    const point = world.city.points.findIndex((q) => q.kind === 'parking');
    const inner = world as unknown as {
      players: Map<number, { pose: { x: number; z: number } }>;
      vehicles: Map<number, { owner?: string; model: number }>;
    };
    Object.assign(inner.players.get(ivy.id)?.pose ?? {}, world.city.points[point]);
    const call = async (car: number) => {
      advance(5000);
      world.message(ivy.conn, encodeClient({ type: 'call_car', point, car }));
      await settle();
    };
    const owned = () => [...inner.vehicles.values()].filter((v) => v.owner === 'ivy');

    await call(9);
    expect(ivy.conn.told().at(-1)).toMatch(/Your Sedan is waiting in bay \d+/);
    expect(owned().map((v) => v.model)).toEqual([0]);
    await call(5);
    expect(ivy.conn.told().at(-1)).toMatch(/Your Compact is waiting/);
    expect(owned().map((v) => v.model)).toEqual([1]);
  });
});

describe('the dealership', () => {
  it('shows every car for sale, lets nobody drive them, and delivers a bought car', async () => {
    const cars = [
      { id: '5', model: 1, colour: 0, name: 'Compact' },
      { id: '12', model: 5, colour: 0, name: 'Sport' },
    ];
    const { world, join, advance } = setup((path) =>
      Promise.resolve(path === 'garage' ? { cars } : {}),
    );
    const dealer = world.city.dealership;
    if (!dealer) throw new Error('no dealership');
    const inner = world as unknown as {
      players: Map<number, { pose: { x: number; z: number } }>;
      vehicles: Map<number, { owner?: string; model: number; pose: { x: number; z: number } }>;
    };
    const onShow = [...inner.vehicles.entries()].filter(([, v]) => v.owner === 'dealer');
    expect(onShow.map(([, v]) => v.model)).toEqual([...DEALER_MODELS]);

    const ivy = await join('ivy');
    const [showId, shown] = onShow[0] as (typeof onShow)[number];
    Object.assign(inner.players.get(ivy.id)?.pose ?? {}, { x: shown.pose.x + 1, z: shown.pose.z });
    world.message(ivy.conn, encodeClient({ type: 'enter_vehicle', vehicle: showId }));
    expect(ivy.conn.take('error').at(-1)?.message).toMatch(/on show/);

    // At the desk, the car just bought comes to a delivery bay.
    const point = world.city.points.findIndex((q) => q.kind === 'dealer');
    Object.assign(inner.players.get(ivy.id)?.pose ?? {}, world.city.points[point]);
    advance(5000);
    world.message(ivy.conn, encodeClient({ type: 'call_car', point, car: 12 }));
    await settle();
    expect(ivy.conn.told().at(-1)).toMatch(/Your Sport is ready in delivery bay 1/);
    const mine = [...inner.vehicles.values()].find((v) => v.owner === 'ivy');
    const bay = dealer.delivery[0] as { x: number; z: number };
    expect(mine).toMatchObject({ model: 5, pose: { x: bay.x, z: bay.z } });
  });
});

describe('taxis', () => {
  // Taxis are off for launch; these check them as they'll be when they're back.
  const taxi = TAXI as { enabled: boolean };
  let was = false;
  beforeEach(() => {
    was = taxi.enabled;
    taxi.enabled = true;
  });
  afterEach(() => {
    taxi.enabled = was;
  });

  const settleAll = () => new Promise((r) => setTimeout(r, 5));

  it('takes a newcomer to the sidewalk nearest where they asked, free', async () => {
    const calls: string[] = [];
    const { world, join, advance } = setup((path) => {
      calls.push(path);
      return Promise.resolve({});
    });
    const ivy = await join('ivy');
    const inner = world as unknown as {
      players: Map<number, { pose: { x: number; z: number } }>;
    };
    const motors = world.city.points.find((q) => q.kind === 'dealer') as { x: number; z: number };
    advance(1000);
    world.message(ivy.conn, encodeClient({ type: 'taxi', x: motors.x, z: motors.z }));
    await settleAll();
    const ride = ivy.conn.take('ride').at(-1);
    expect(ride).toMatchObject({ cents: 0, text: '' });
    expect(ride?.seconds).toBeGreaterThan(2);
    expect(calls).not.toContain('fare');
    const at = inner.players.get(ivy.id)?.pose as { x: number; z: number };
    expect(Math.hypot(at.x - motors.x, at.z - motors.z)).toBeLessThan(40);
    expect(world.collision.pointBlocked(at.x, at.z, 0.5)).toBe(false);
    expect(ivy.conn.take('correction').length).toBeGreaterThan(0);

    // Straight away again: the cab has only just left.
    world.message(ivy.conn, encodeClient({ type: 'taxi', x: 0, z: -400 }));
    await settleAll();
    expect(ivy.conn.take('ride').at(-1)?.text).toMatch(/last cab just left/);
  });

  it('charges a fare through the API once a player is past the newcomer levels', async () => {
    const fares: Record<string, unknown>[] = [];
    let broke = false;
    const { world, join, advance } = setup((path, body) => {
      if (path !== 'fare') return Promise.resolve({});
      if (broke) return Promise.reject(new Error('Not enough money for the fare.'));
      fares.push(body);
      return Promise.resolve({ status: 'posted', balance: 1 });
    });
    const vet = await join('vet');
    advance(1000);
    world.message(vet.conn, encodeClient({ type: 'taxi', x: 300, z: 600 }));
    await settleAll();
    const ride = vet.conn.take('ride').at(-1);
    expect(ride?.cents).toBeGreaterThan(0);
    expect(fares).toEqual([
      expect.objectContaining({ account: 'vet', kind: 'taxi', cents: ride?.cents }),
    ]);

    broke = true;
    advance(60_000);
    world.message(vet.conn, encodeClient({ type: 'taxi', x: -600, z: 300 }));
    await settleAll();
    expect(vet.conn.take('ride').at(-1)).toMatchObject({
      seconds: 0,
      text: 'Not enough money for the fare.',
    });
  });

  it('turns down rides that are too short, during a shift, or straight after being hurt', async () => {
    const { world, join, advance } = setup(() => Promise.resolve({}));
    const ivy = await join('ivy');
    const inner = world as unknown as {
      players: Map<number, { pose: { x: number; z: number }; hurtAt: number }>;
    };
    const p = inner.players.get(ivy.id) as { pose: { x: number; z: number }; hurtAt: number };
    advance(1000);
    world.message(ivy.conn, encodeClient({ type: 'taxi', x: p.pose.x + 20, z: p.pose.z }));
    await settleAll();
    expect(ivy.conn.take('ride').at(-1)?.text).toMatch(/Walk it/);

    p.hurtAt = 1_000_500;
    world.message(ivy.conn, encodeClient({ type: 'taxi', x: 0, z: 600 }));
    await settleAll();
    expect(ivy.conn.take('ride').at(-1)?.text).toMatch(/safe/);

    advance(60_000);
    const depot = world.city.points.findIndex((q) => q.kind === 'depot');
    Object.assign(p.pose, world.city.points[depot]);
    world.message(ivy.conn, encodeClient({ type: 'job', op: JOB_OP.START, point: depot }));
    await settleAll();
    world.message(ivy.conn, encodeClient({ type: 'taxi', x: 0, z: 600 }));
    await settleAll();
    expect(ivy.conn.take('ride').at(-1)?.text).toMatch(/during a shift/);
  });
});

describe('fuel and repairs at a car park', () => {
  // Damage is off for launch; this checks repairs as they'll be when it's back.
  const damage = DAMAGE as { enabled: boolean };
  let was = false;
  beforeEach(() => {
    was = damage.enabled;
    damage.enabled = true;
  });
  afterEach(() => {
    damage.enabled = was;
  });

  it('fills and fixes the player’s own car for what it lacks, and the garage keeps its condition', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const cars = [{ id: '5', model: 1, colour: 0, name: 'Compact', fuel: 0.4, health: 0.3 }];
    const { world, join, advance } = setup((path, body) => {
      calls.push([path, body]);
      return Promise.resolve(path === 'garage' ? { cars } : { status: 'posted', balance: 1 });
    });
    const ivy = await join('ivy');
    const point = world.city.points.findIndex((q) => q.kind === 'parking');
    const inner = world as unknown as {
      players: Map<number, { pose: { x: number; z: number } }>;
      vehicles: Map<
        number,
        { owner?: string; fuel: number; health: number; pose: { state: number } }
      >;
    };
    Object.assign(inner.players.get(ivy.id)?.pose ?? {}, world.city.points[point]);
    advance(5000);
    world.message(ivy.conn, encodeClient({ type: 'call_car', point, car: 5 }));
    await settle();
    // Out of the garage as it went in: low on fuel, smoking.
    const mine = [...inner.vehicles.values()].find((v) => v.owner === 'ivy');
    expect(mine).toMatchObject({ fuel: 0.4, health: 0.3 });
    expect(ivy.conn.take('car').at(-1)?.health).toBeCloseTo(0.3, 1);

    const service = async (what: number) => {
      advance(2000);
      world.message(ivy.conn, encodeClient({ type: 'service', point, what }));
      await settle();
    };
    await service(SERVICE.FUEL);
    await service(SERVICE.REPAIR);
    const fares = calls.filter(([path]) => path === 'fare').map(([, b]) => [b.kind, b.cents]);
    expect(fares).toEqual([
      ['fuel', fuelCost(0.4)],
      ['repair', repairCost(0.3)],
    ]);
    expect(mine).toMatchObject({ fuel: 1, health: 1 });
    expect(ivy.conn.told().slice(-2)).toEqual([
      expect.stringMatching(/Tank full/),
      expect.stringMatching(/Repaired/),
    ]);
    // Nothing left to do: no charge.
    await service(SERVICE.FUEL);
    expect(calls.filter(([path]) => path === 'fare')).toHaveLength(2);

    // Back to the garage with them: its condition is kept.
    if (mine) mine.health = 0.6;
    world.close(ivy.conn);
    await settle();
    for (let i = 0; i < 2000 && !calls.some(([p]) => p === 'garage/condition'); i += 1) {
      advance(1000);
      world.step();
    }
    expect(calls.find(([path]) => path === 'garage/condition')?.[1]).toEqual({
      account: 'ivy',
      car: 5,
      fuel: 1,
      health: 0.6,
    });
  });
});

describe('the newcomer’s rental', () => {
  it('goes back to the Car Dealership when it’s due, and an empty garage brings no car', async () => {
    let cars = [
      {
        id: '5',
        model: 1,
        colour: 0,
        name: 'Compact',
        expiresAt: new Date(Date.now() + 40).toISOString(),
      },
    ];
    const { world, join, advance } = setup((path) =>
      Promise.resolve(path === 'garage' ? { cars } : {}),
    );
    const ivy = await join('ivy');
    const point = world.city.points.findIndex((q) => q.kind === 'parking');
    const inner = world as unknown as {
      players: Map<number, { pose: { x: number; z: number } }>;
      vehicles: Map<number, { owner?: string }>;
    };
    Object.assign(inner.players.get(ivy.id)?.pose ?? {}, world.city.points[point]);
    advance(5000);
    world.message(ivy.conn, encodeClient({ type: 'call_car', point, car: 5 }));
    await settle();
    const mine = () => [...inner.vehicles.values()].filter((v) => v.owner === 'ivy');
    expect(mine()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));
    for (let i = 0; i < 40; i += 1) world.step();
    expect(mine()).toHaveLength(0);
    expect(ivy.conn.told().at(-1)).toMatch(/rental is due back/);

    cars = [];
    advance(5000);
    world.message(ivy.conn, encodeClient({ type: 'call_car', point, car: 5 }));
    await settle();
    expect(mine()).toHaveLength(0);
    expect(ivy.conn.told().at(-1)).toMatch(/garage is empty/);
  });
});
