import { describe, expect, it } from 'vitest';
import { DecodeError, Reader, Writer } from './buffer.ts';
import {
  type ClientMessage,
  decodeClient,
  decodeServer,
  decodeServerFrame,
  encodeClient,
  encodeServer,
  FLAG,
  MODE,
  modeOf,
  type Pose,
  type ServerMessage,
  SnapshotEncoder,
  writeServer,
} from './codec.ts';

const pose: Pose = {
  x: -1234.5,
  y: 12.25,
  z: 987.75,
  yaw: 1.25,
  vx: 6.2,
  vy: -3.1,
  vz: -0.5,
  state: MODE.RUN | FLAG.AIM,
};

function expectPoseClose(actual: Pose, expected: Pose) {
  expect(actual.x).toBeCloseTo(expected.x, 1);
  expect(actual.y).toBeCloseTo(expected.y, 1);
  expect(actual.z).toBeCloseTo(expected.z, 1);
  expect(actual.yaw).toBeCloseTo(expected.yaw, 3);
  expect(actual.vx).toBeCloseTo(expected.vx, 2);
  expect(actual.vy).toBeCloseTo(expected.vy, 2);
  expect(actual.vz).toBeCloseTo(expected.vz, 2);
  expect(actual.state).toBe(expected.state);
}

describe('buffer', () => {
  it('round-trips signed 24-bit integers at both ends of the range', () => {
    const w = new Writer(4);
    for (const v of [0, 1, -1, 0x7fffff, -0x7fffff, 123_456, -654_321]) w.i24(v);
    const r = new Reader(w.done());
    for (const v of [0, 1, -1, 0x7fffff, -0x7fffff, 123_456, -654_321]) expect(r.i24()).toBe(v);
    r.end();
  });

  it('grows past its initial capacity', () => {
    const w = new Writer(2);
    for (let i = 0; i < 100; i += 1) w.u32(i);
    expect(w.length).toBe(400);
  });
});

describe('client messages', () => {
  it('round-trips every message', () => {
    const messages: ClientMessage[] = [
      {
        type: 'hello',
        version: 2,
        name: 'Ada Lovelace',
        token: 'eyJhbGciOiJFUzI1NiJ9.payload.sig',
      },
      { type: 'ping', clientTime: 123456.789 },
      { type: 'enter_vehicle', vehicle: 42 },
      { type: 'exit_vehicle' },
      { type: 'job', op: 2, point: 513 },
      { type: 'call_car', point: 77, car: 3_000_000_123 },
      { type: 'taxi', x: -1234.5, z: 987.25 },
      { type: 'service', point: 4100, what: 2 },
      { type: 'equip', weapon: 2 },
      { type: 'reload' },
      { type: 'buy', point: 4101, item: 3 },
      { type: 'revive', target: 77 },
    ];
    for (const m of messages) expect(decodeClient(encodeClient(m))).toEqual(m);
  });

  it('round-trips a state report within quantisation', () => {
    const m = decodeClient(encodeClient({ type: 'state', seq: 65535, ...pose }));
    expect(m.type).toBe('state');
    if (m.type !== 'state') return;
    expect(m.seq).toBe(65535);
    expectPoseClose(m, pose);
    expect(modeOf(m.state)).toBe(MODE.RUN);
  });

  it('keeps a state report small', () => {
    expect(encodeClient({ type: 'state', seq: 1, ...pose }).byteLength).toBe(20);
  });

  it('round-trips a shot', () => {
    const m = decodeClient(
      encodeClient({
        type: 'shot',
        seq: 9,
        weapon: 1,
        viewTime: 4_000_000_000,
        x: 10,
        y: 1.5,
        z: -20,
        yaw: 3,
        pitch: -0.25,
      }),
    );
    expect(m).toMatchObject({ type: 'shot', seq: 9, weapon: 1, viewTime: 4_000_000_000 });
    if (m.type !== 'shot') return;
    expect(m.pitch).toBeCloseTo(-0.25, 3);
  });

  it('rejects truncated, trailing and unknown messages', () => {
    const bytes = encodeClient({ type: 'enter_vehicle', vehicle: 1 });
    expect(() => decodeClient(bytes.subarray(0, 2))).toThrow(DecodeError);
    expect(() => decodeClient(new Uint8Array([...bytes, 0]))).toThrow(DecodeError);
    expect(() => decodeClient(new Uint8Array([250]))).toThrow(DecodeError);
  });

  it('rejects over-long names', () => {
    const bytes = encodeClient({ type: 'hello', version: 2, name: 'x'.repeat(40), token: '' });
    expect(() => decodeClient(bytes)).toThrow(DecodeError);
  });
});

describe('server messages', () => {
  it('round-trips the simple messages', () => {
    const messages: ServerMessage[] = [
      {
        type: 'enter',
        id: 7,
        kind: 1,
        model: 2,
        variant: 3,
        name: 'Taxi',
        look: 0,
        gear: 0,
        faction: 0,
        level: 0,
      },
      {
        type: 'enter',
        id: 8,
        kind: 0,
        model: 0,
        variant: 0,
        name: 'Ada Byron',
        look: 0xb35,
        gear: 0x1a2b3,
        faction: 1,
        level: 12,
      },
      { type: 'leave', id: 7 },
      { type: 'pong', clientTime: 1.5, serverTime: 99.25 },
      { type: 'clock', realMs: 1_700_000_000_000, gameMinutes: 480, rate: 30 },
      { type: 'seat', vehicle: 3, driver: 0xffff },
      { type: 'hit', target: 1, shooter: 2, zone: 1, damage: 45, hp: 55 },
      { type: 'health', hp: 0, downed: true },
      { type: 'error', code: 2, message: 'Server full' },
      { type: 'voice', url: 'wss://voice.example.com', token: 'eyJ'.padEnd(600, 'x') },
      { type: 'job', state: '{"job":"courier","step":"Deliver"}' },
      { type: 'job', state: '' },
      { type: 'reward', cents: 42_500, xp: 60, totalXp: 1_234_567, reason: 'Delivery · Grand Ave' },
      { type: 'ride', seconds: 3.5, cents: 1_840, text: 'Car Dealership' },
      { type: 'ride', seconds: 0, cents: 0, text: 'Not during a shift.' },
      { type: 'car', vehicle: 77, fuel: 51 / 255, health: 1 },
      { type: 'car', vehicle: 78, fuel: 0, health: 0 },
      { type: 'arms', state: '{"licence":true}' },
      { type: 'dispatch', state: '[]' },
    ];
    for (const m of messages) expect(decodeServer(encodeServer(m))).toEqual(m);
  });

  it('round-trips welcome and correction poses', () => {
    const welcome = decodeServer(
      encodeServer({
        type: 'welcome',
        version: 1,
        you: 5,
        serverTime: 1234,
        clock: { realMs: 1, gameMinutes: 2, rate: 30 },
        spawn: pose,
      }),
    );
    if (welcome.type !== 'welcome') throw new Error(welcome.type);
    expectPoseClose(welcome.spawn, pose);
    const correction = decodeServer(encodeServer({ type: 'correction', seq: 3, ...pose }));
    if (correction.type !== 'correction') throw new Error(correction.type);
    expectPoseClose(correction, pose);
  });

  it('encodes shot effects with and without a hit distance', () => {
    const base = {
      type: 'shot_fx',
      shooter: 1,
      weapon: 2,
      x: 0,
      y: 1,
      z: 0,
      yaw: 0,
      pitch: 0,
    } as const;
    const near = decodeServer(encodeServer({ ...base, distance: 12.3 }));
    const miss = decodeServer(encodeServer({ ...base, distance: -1 }));
    expect(near).toMatchObject({ distance: 12.3 });
    expect(miss).toMatchObject({ distance: -1 });
  });

  it('builds snapshots incrementally at 17 bytes per entity', () => {
    const writer = new Writer(16);
    const enc = new SnapshotEncoder(writer).begin(777);
    for (let id = 0; id < 3; id += 1) {
      enc.entity(id, { x: id * 10, y: 0, z: -id, yaw: 0.5, vx: 1, vz: -1, state: MODE.WALK });
    }
    const bytes = enc.finish();
    expect(bytes.byteLength).toBe(7 + 3 * 17);
    const m = decodeServer(bytes);
    if (m.type !== 'snapshot') throw new Error(m.type);
    expect(m.serverTime).toBe(777);
    expect(m.entities.map((e) => e.id)).toEqual([0, 1, 2]);
    expect(m.entities[2]?.x).toBe(20);
    // The encoder is reused for the next client without leaking the previous entries.
    writer.reset();
    const empty = decodeServer(enc.begin(778).finish());
    expect(empty).toEqual({ type: 'snapshot', serverTime: 778, entities: [] });
  });

  it('carries several messages in one frame', () => {
    const w = new Writer(8);
    writeServer({ type: 'leave', id: 4 }, w);
    writeServer(
      {
        type: 'enter',
        id: 9,
        kind: 0,
        model: 0,
        variant: 0,
        name: 'Bo',
        look: 7,
        gear: 5,
        faction: 2,
      },
      w,
    );
    const snap = new SnapshotEncoder(w).begin(5);
    snap.entity(9, { x: 1, y: 0, z: 2, yaw: 0, vx: 0, vz: 0, state: MODE.IDLE });
    const frame = decodeServerFrame(snap.finish());
    expect(frame.map((m) => m.type)).toEqual(['leave', 'enter', 'snapshot']);
    expect(() => decodeServer(w.peek())).toThrow(DecodeError);
  });
});
