/**
 * In-process benchmark of the world tick with N players and no network: isolates the world's
 * own CPU cost from transport and bot load. Players bounce around a box of streets (spread) or
 * the plaza (crowd).
 *   PLAYERS 500   TICKS 300   SCENARIO spread|crowd
 * Run with --cpu-prof to profile.
 */
import { decodeServer, encodeClient, MODE, PROTOCOL_VERSION, Writer } from '@fr33world/protocol';
import { CLIENT_SEND_HZ, TICK_HZ } from '@fr33world/shared';
import type { Conn } from '../transport.ts';
import { World } from '../world.ts';

const players = Number(process.env.PLAYERS ?? 500);
const ticks = Number(process.env.TICKS ?? 300);
const crowd = process.env.SCENARIO === 'crowd';

let clock = 0;
const world = new World({ maxPlayers: players + 1, now: () => clock });
let bytes = 0;

interface Sim {
  conn: Conn;
  x: number;
  z: number;
  vx: number;
  vz: number;
  seq: number;
}
const sims: Sim[] = [];
const writer = new Writer(64);
for (let i = 0; i < players; i += 1) {
  const sim: Sim = { conn: null as unknown as Conn, x: 0, z: 0, vx: 0, vz: 0, seq: 0 };
  let welcomed = false;
  sim.conn = {
    id: i + 1,
    remote: 'bench',
    send: (b) => {
      bytes += b.byteLength;
      if (!welcomed) {
        const m = decodeServer(new Uint8Array(b));
        if (m.type === 'welcome') {
          welcomed = true;
          sim.x = m.spawn.x;
          sim.z = m.spawn.z;
        }
      }
    },
    buffered: () => 0,
    close: () => {},
  };
  world.open(sim.conn);
  world.message(
    sim.conn,
    encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: `P${i}`, token: '' }, writer),
  );
  const a = Math.random() * Math.PI * 2;
  sim.vx = Math.cos(a) * 5;
  sim.vz = Math.sin(a) * 5;
  sims.push(sim);
}

const msPerTick = 1000 / TICK_HZ;
const sendEvery = TICK_HZ / CLIENT_SEND_HZ;
let msgTime = 0;
const stepSamples: number[] = [];
let due = 0;
for (let t = 0; t < ticks; t += 1) {
  clock += msPerTick;
  const m0 = performance.now();
  due += 1;
  if (due >= sendEvery) {
    due -= sendEvery;
    const lim = crowd ? 35 : 230;
    const cx = crowd ? -64 : 0;
    const cz = crowd ? -62 : 0;
    for (const s of sims) {
      if (Math.abs(s.x + s.vx / CLIENT_SEND_HZ - cx) > lim) s.vx = -s.vx;
      if (Math.abs(s.z + s.vz / CLIENT_SEND_HZ - cz) > lim) s.vz = -s.vz;
      s.x += s.vx / CLIENT_SEND_HZ;
      s.z += s.vz / CLIENT_SEND_HZ;
      s.seq = (s.seq + 1) & 0xffff;
      const state = { type: 'state' as const, seq: s.seq, x: s.x, y: 0, z: s.z, yaw: 0 };
      world.message(
        s.conn,
        encodeClient({ ...state, vx: s.vx, vy: 0, vz: s.vz, state: MODE.RUN }, writer),
      );
    }
  }
  const s0 = performance.now();
  world.step();
  const s1 = performance.now();
  msgTime += s0 - m0;
  if (t > 30) stepSamples.push(s1 - s0);
}
stepSamples.sort((a, b) => a - b);
const pct = (q: number) => +(stepSamples[Math.floor(q * (stepSamples.length - 1))] ?? 0).toFixed(2);
const stats = world.stats();
console.log(
  JSON.stringify({
    players,
    scenario: crowd ? 'crowd' : 'spread',
    stepMsP50: pct(0.5),
    stepMsP95: pct(0.95),
    messagesMsPerTick: +(msgTime / ticks).toFixed(2),
    corrections: stats.corrections,
    perPlayerKBps: +(bytes / players / (ticks / TICK_HZ) / 1024).toFixed(2),
  }),
);
