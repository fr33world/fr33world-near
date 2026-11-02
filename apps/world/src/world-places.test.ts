import { DOOR, generateCity, INTERIORS, interiorAt } from '@fr33world/city';
import { decodeServerFrame, encodeClient, PROTOCOL_VERSION } from '@fr33world/protocol';
import type { ServerMessage } from '@fr33world/protocol';
import { describe, expect, it } from 'vitest';
import type { Conn } from './transport.ts';
import { GHOST_MS, World } from './world.ts';

class FakeConn implements Conn {
  static next = 7000;
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
  welcome() {
    const w = this.inbox.find((m) => m.type === 'welcome');
    if (w?.type !== 'welcome') throw new Error('no welcome');
    return w;
  }
}

const city = generateCity();
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
interface Saved {
  account: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function setup(place: Partial<Saved> | null | 'hangs' = null) {
  let clock = 1_000_000;
  const saves: Saved[] = [];
  const world = new World({
    city,
    now: () => clock,
    authenticate: (token) => Promise.resolve({ account: token, name: `${token} Player` }),
    staffApi: (path, body) => {
      if (path === 'place') {
        if (place === 'hangs') return new Promise(() => {});
        return Promise.resolve({ place });
      }
      if (path === 'place/save') saves.push(...(body.places as Saved[]));
      return Promise.resolve({});
    },
  });
  const inner = world as unknown as {
    players: Map<number, { pose: { x: number; z: number }; downedUntil: number; bed: number }>;
  };
  const join = async (token: string) => {
    const conn = new FakeConn();
    world.open(conn);
    world.message(
      conn,
      encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: 'x', token }),
    );
    await settle();
    return conn;
  };
  const advance = (ms: number) => {
    clock += ms;
    world.step();
  };
  return { world, inner, join, saves, advance };
}

describe('coming back where you left', () => {
  const street = city.playerSpawns[0] as { x: number; z: number };

  it('starts a new character at a spawn', async () => {
    const t = setup(null);
    const w = (await t.join('new')).welcome();
    expect(city.playerSpawns.some((s) => Math.hypot(s.x - w.spawn.x, s.z - w.spawn.z) < 40)).toBe(
      true,
    );
  });

  it('brings a player back to their last place, however long they were away', async () => {
    const t = setup({ x: street.x + 3, y: 0.1, z: street.z + 2, yaw: 1.25 });
    const w = (await t.join('back')).welcome();
    expect(w.spawn.x).toBeCloseTo(street.x + 3);
    expect(w.spawn.z).toBeCloseTo(street.z + 2);
    expect(w.spawn.yaw).toBeCloseTo(1.25);
  });

  it('brings them back inside a building', async () => {
    const room = INTERIORS.police;
    const t = setup({ ...room.spawn, y: 0 });
    const w = (await t.join('indoors')).welcome();
    expect(interiorAt(w.spawn.x, w.spawn.z)?.id).toBe('police');
    expect(w.spawn.y).toBe(0);
  });

  it('falls back to a spawn from inside a wall or out at sea', async () => {
    const b = city.buildings.find((q) => q.y === undefined && Math.min(q.w, q.d) > 12);
    if (!b) throw new Error('no building');
    for (const place of [
      { x: b.x, y: 0, z: b.z, yaw: 0 },
      { x: 90_000, y: 0, z: 90_000, yaw: 0 },
    ]) {
      const w = (await setup(place).join('lost')).welcome();
      expect(city.playerSpawns.some((s) => Math.hypot(s.x - w.spawn.x, s.z - w.spawn.z) < 40)).toBe(
        true,
      );
    }
  });

  it('never leaves logging in waiting on a stuck API', async () => {
    const t = setup('hangs');
    const conn = new FakeConn();
    t.world.open(conn);
    t.world.message(
      conn,
      encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: 'x', token: 'slow' }),
    );
    await new Promise((r) => setTimeout(r, 2600));
    expect(conn.welcome().you).toBeGreaterThan(0);
  }, 5000);

  it('saves where they were when they leave for good', async () => {
    const t = setup(null);
    const conn = await t.join('leaver');
    const id = conn.welcome().you;
    const body = t.inner.players.get(id);
    if (!body) throw new Error('no body');
    Object.assign(body.pose, { x: street.x + 9, z: street.z - 4 });
    t.world.close(conn);
    t.advance(GHOST_MS + 1);
    expect(t.inner.players.has(id)).toBe(false);
    const last = t.saves.at(-1);
    expect(last?.account).toBe('leaver');
    expect(last?.x).toBeCloseTo(street.x + 9);
    expect(last?.z).toBeCloseTo(street.z - 4);
  });

  it('sends a player who quits while down to the Hospital, not back where they fell', async () => {
    const t = setup(null);
    const conn = await t.join('quitter');
    const body = t.inner.players.get(conn.welcome().you);
    if (!body) throw new Error('no body');
    body.downedUntil = 2_000_000_000;
    await t.world.saveAllPlaces();
    const door = city.points.find((p) => p.kind === 'entrance' && p.service === 'hospital');
    const last = t.saves.at(-1);
    if (!door || !last) throw new Error('nothing saved');
    expect(Math.hypot(last.x - door.x, last.z - door.z)).toBeCloseTo(DOOR.stepOut);
  });

  it('doesn’t save a player who hasn’t moved', async () => {
    const t = setup(null);
    await t.join('still');
    await t.world.saveAllPlaces();
    const n = t.saves.length;
    await t.world.saveAllPlaces();
    expect(t.saves).toHaveLength(n);
  });
});
