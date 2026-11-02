import {
  type ClientMessage,
  decodeServerFrame,
  encodeClient,
  MODE,
  PROTOCOL_VERSION,
  type ServerMessage,
  WEAPON,
} from '@fr33world/protocol';
import { DOWNED_SECONDS, HITBOX, SHOOT_HEIGHT, TICK_HZ, WEAPONS, MEDICAL } from '@fr33world/shared';
import { describe, expect, it } from 'vitest';
import type { Conn } from './transport.ts';
import { World } from './world.ts';

class FakeConn implements Conn {
  static next = 1000;
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
  /** Removes and returns the messages of one type received so far. */
  take<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    const out = this.inbox.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    for (let i = this.inbox.length - 1; i >= 0; i -= 1)
      if (this.inbox[i]?.type === type) this.inbox.splice(i, 1);
    return out;
  }
}

function setup(safe = false) {
  let clock = 1_000_000;
  const world = new World({ now: () => clock, ...(safe ? {} : { safeZones: [] }) });
  const tick = (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock += 1000 / TICK_HZ;
      world.step();
    }
  };
  const send = (conn: Conn, m: ClientMessage) => world.message(conn, encodeClient(m));
  const join = (name: string) => {
    const conn = new FakeConn();
    world.open(conn);
    send(conn, { type: 'hello', version: PROTOCOL_VERSION, name, token: '' });
    const w = conn.take('welcome')[0];
    if (!w) throw new Error('no welcome');
    return { conn, id: w.you, pos: { ...w.spawn } };
  };
  /** Aims from a's chest at a point `up` metres above b's feet. */
  const shoot = (
    a: ReturnType<typeof join>,
    at: { x: number; y: number; z: number },
    viewTime: number,
    up = 1.2,
  ) => {
    const o = { x: a.pos.x, y: a.pos.y + SHOOT_HEIGHT, z: a.pos.z };
    const dx = at.x - o.x;
    const dy = at.y + up - o.y;
    const dz = at.z - o.z;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    send(a.conn, {
      type: 'shot',
      seq: 1,
      weapon: WEAPON.ASSAULT_RIFLE,
      viewTime,
      ...o,
      yaw,
      pitch,
    });
  };
  return { world, tick, send, join, shoot, now: () => clock };
}

describe('combat', () => {
  it('hits a player in the body and reports damage to both sides', () => {
    const { world, tick, join, shoot } = setup();
    const a = join('Shooter');
    const b = join('Target');
    tick(2);
    shoot(a, b.pos, world.serverTime());
    const hit = b.conn.take('hit')[0];
    expect(hit).toMatchObject({
      target: b.id,
      shooter: a.id,
      damage: WEAPONS[WEAPON.ASSAULT_RIFLE]?.body,
    });
    expect(a.conn.take('hit')).toHaveLength(1);
    expect(b.conn.take('health')[0]?.hp).toBe(100 - (WEAPONS[WEAPON.ASSAULT_RIFLE]?.body ?? 0));
  });

  it('counts head shots as head shots', () => {
    const { world, tick, join, shoot } = setup();
    const a = join('Shooter');
    const b = join('Target');
    tick(2);
    shoot(a, b.pos, world.serverTime(), HITBOX.headY);
    expect(b.conn.take('hit')[0]?.damage).toBe(WEAPONS[WEAPON.ASSAULT_RIFLE]?.head);
  });

  it('hits where the shooter saw the target (lag compensation), within the rewind cap', () => {
    const { world, tick, send, join, shoot } = setup();
    const a = join('Shooter');
    const b = join('Target');
    tick(3);
    const seenAt = world.serverTime();
    const old = { ...b.pos };
    // The target strafes 1.2 m sideways (perpendicular to the line of fire) over 150 ms.
    const ax = old.x - a.pos.x;
    const az = old.z - a.pos.z;
    const len = Math.hypot(ax, az);
    const side = { x: -az / len, z: ax / len };
    for (let i = 1; i <= 4; i += 1) {
      tick(1);
      const k = (1.2 * i) / 4;
      send(b.conn, {
        type: 'state',
        seq: i,
        ...old,
        x: old.x + side.x * k,
        z: old.z + side.z * k,
        state: MODE.RUN,
      });
    }
    tick(1);
    // Aiming at the old spot with the old view time: hit. With "now" as view time: miss.
    shoot(a, old, seenAt);
    expect(b.conn.take('hit')).toHaveLength(1);
    tick(10);
    shoot(a, old, world.serverTime());
    expect(b.conn.take('hit')).toHaveLength(0);
  });

  it('never rewinds further than the cap', () => {
    const { world, tick, send, join, shoot } = setup();
    const a = join('Shooter');
    const b = join('Target');
    tick(3);
    const longAgo = world.serverTime();
    const old = { ...b.pos };
    const ax = old.x - a.pos.x;
    const az = old.z - a.pos.z;
    const len = Math.hypot(ax, az);
    for (let i = 1; i <= 8; i += 1) {
      tick(3);
      const k = (1.5 * i) / 8;
      send(b.conn, {
        type: 'state',
        seq: i,
        ...old,
        x: old.x - (az / len) * k,
        z: old.z + (ax / len) * k,
      });
    }
    tick(6);
    // 1 s later, claiming to have seen the target 1 s ago: rewinds only 200 ms, so it misses.
    shoot(a, old, longAgo);
    expect(b.conn.take('hit')).toHaveLength(0);
  });

  it('enforces fire rate and a muzzle near the shooter', () => {
    const { world, tick, send, join, shoot } = setup();
    const a = join('Shooter');
    const b = join('Target');
    tick(2);
    shoot(a, b.pos, world.serverTime());
    shoot(a, b.pos, world.serverTime());
    expect(b.conn.take('hit')).toHaveLength(1);
    tick(6);
    // Muzzle claimed 10 m from the shooter: ignored.
    send(a.conn, {
      type: 'shot',
      seq: 2,
      weapon: WEAPON.ASSAULT_RIFLE,
      viewTime: world.serverTime(),
      x: b.pos.x,
      y: 1.5,
      z: b.pos.z - 2,
      yaw: 0,
      pitch: 0,
    });
    expect(b.conn.take('hit')).toHaveLength(0);
  });

  it('does nothing in a safe zone', () => {
    const { world, tick, join, shoot } = setup(true);
    const a = join('Shooter');
    const b = join('Target');
    tick(2);
    shoot(a, b.pos, world.serverTime());
    expect(b.conn.take('hit')).toHaveLength(0);
  });

  it('downs a player at 0 HP, freezes them, then wakes them in a hospital bed', () => {
    const { world, tick, send, join, shoot } = setup();
    const a = join('Shooter');
    const b = join('Target');
    tick(2);
    for (let i = 0; i < 6; i += 1) {
      shoot(a, b.pos, world.serverTime());
      tick(4);
    }
    const last = b.conn.take('health').at(-1);
    expect(last).toEqual({ type: 'health', hp: 0, downed: true });
    // Downed bodies don't move.
    send(b.conn, { type: 'state', seq: 99, ...b.pos, x: b.pos.x + 0.5 });
    b.conn.inbox.length = 0;
    tick(TICK_HZ * DOWNED_SECONDS + 2);
    expect(b.conn.take('correction')).toHaveLength(1);
    expect(b.conn.take('health').at(-1)).toEqual({
      type: 'health',
      hp: MEDICAL.bedStartHp,
      downed: true,
    });
  });
});
