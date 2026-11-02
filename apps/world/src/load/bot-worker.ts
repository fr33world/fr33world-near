/**
 * Runs a batch of headless bots in a worker thread. Each bot joins Horizon, then moves like a
 * player: running and walking along the street grid ("spread") or milling in the spawn plaza
 * ("crowd"), reporting its pose at CLIENT_SEND_HZ and pinging every two seconds. A network
 * conditioner delays traffic both ways (latency, jitter, and loss as TCP would show it: a
 * retransmit stall that holds back everything behind it).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { generateCity, roadHalfWidth } from '@fr33world/city';
import {
  decodeServerFrame,
  encodeClient,
  MODE,
  PROTOCOL_VERSION,
  S2C,
  Writer,
} from '@fr33world/protocol';
import { CLIENT_SEND_HZ } from '@fr33world/shared';
import WebSocket from 'ws';

export interface WorkerConfig {
  url: string;
  firstBot: number;
  bots: number;
  rampPerSecond: number;
  scenario: 'spread' | 'crowd';
  latencyMs: number;
  jitterMs: number;
  loss: number;
  /** One bot in this many decodes every snapshot (to count visible entities). */
  sampleEvery: number;
}

export interface WorkerReport {
  connected: number;
  bytesIn: number;
  framesIn: number;
  snapshotEntities: number;
  snapshotsDecoded: number;
  corrections: number;
  errors: number;
  rtts: number[];
}

const cfg = workerData as WorkerConfig;
const city = generateCity();
const plaza = city.plaza;
const plazaCentre = { x: (plaza.x0 + plaza.x1) / 2, z: (plaza.z0 + plaza.z1) / 2 };
const nsRoads = city.roads.filter((r) => r.axis === 'ns');
const ewRoads = city.roads.filter((r) => r.axis === 'ew' && r.center < 180);
const grand = city.roads.find((r) => r.name === 'Grand Avenue');

const report: WorkerReport = {
  connected: 0,
  bytesIn: 0,
  framesIn: 0,
  snapshotEntities: 0,
  snapshotsDecoded: 0,
  corrections: 0,
  errors: 0,
  rtts: [],
};

/** Keeps message order while delaying each by latency ± jitter, plus retransmit stalls. */
class Link {
  private releaseAt = 0;
  private readonly queue: { at: number; fn: () => void }[] = [];
  delay(fn: () => void) {
    const now = performance.now();
    let at = now + cfg.latencyMs + (Math.random() * 2 - 1) * cfg.jitterMs;
    if (Math.random() < cfg.loss) at += 200;
    at = Math.max(at, this.releaseAt);
    this.releaseAt = at;
    if (this.queue.length === 0) activeLinks.add(this);
    this.queue.push({ at, fn });
  }
  /** Runs everything due by `now`; queues are in release order, so this stops early. */
  flush(now: number) {
    let i = 0;
    while (i < this.queue.length && (this.queue[i] as { at: number }).at <= now) {
      (this.queue[i] as { fn: () => void }).fn();
      i += 1;
    }
    if (i > 0) this.queue.splice(0, i);
    if (this.queue.length === 0) activeLinks.delete(this);
  }
}

// One 4 ms timer wheel for every link in the worker, instead of a timer per message, so the
// bots spend their CPU being players rather than scheduling.
const activeLinks = new Set<Link>();
setInterval(() => {
  const now = performance.now();
  for (const link of activeLinks) link.flush(now);
}, 4);

interface Bot {
  ws: WebSocket;
  up: Link;
  down: Link;
  ready: boolean;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  path: { x: number; z: number }[];
  seq: number;
  decodes: boolean;
  /** Tick (mod PING_EVERY) on which this bot pings, spreading pings over time. */
  pingPhase: number;
  send: (bytes: Uint8Array) => void;
}

const PING_EVERY = CLIENT_SEND_HZ * 2;

const bots: Bot[] = [];
const writer = new Writer(64);

function rand(lo: number, hi: number) {
  return lo + Math.random() * (hi - lo);
}

/** Plans a route that stays on the carriageways: along a street, turn at a junction, repeat. */
function planSpread(bot: Bot) {
  const lane = () => rand(-5, 5);
  if (bot.path.length === 0 && grand && Math.abs(bot.z - grand.center) > 8) {
    // First leave the plaza northwards onto Grand Avenue.
    bot.path.push({ x: bot.x, z: grand.center + lane() * 0.5 });
  }
  let at = bot.path.at(-1) ?? { x: bot.x, z: bot.z };
  for (let leg = 0; leg < 6; leg += 1) {
    const onNs = nsRoads.find((r) => Math.abs(at.x - r.center) < roadHalfWidth(r));
    if (onNs && Math.random() < 0.5) {
      const ew = ewRoads[Math.floor(Math.random() * ewRoads.length)];
      if (ew) at = { x: at.x, z: ew.center + lane() * 0.6 };
    } else {
      const ns = nsRoads[Math.floor(Math.random() * nsRoads.length)];
      if (ns) at = { x: ns.center + lane() * 0.6, z: at.z };
    }
    bot.path.push(at);
  }
}

function planCrowd(bot: Bot) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * 40;
  bot.path.push({ x: plazaCentre.x + Math.cos(a) * r, z: plazaCentre.z + Math.sin(a) * r });
}

function connect(index: number) {
  const ws = new WebSocket(cfg.url, { perMessageDeflate: false });
  ws.binaryType = 'nodebuffer';
  const bot: Bot = {
    ws,
    up: new Link(),
    down: new Link(),
    ready: false,
    x: 0,
    z: 0,
    yaw: 0,
    speed: Math.random() < 0.75 ? rand(4.5, 5.8) : rand(1.3, 1.8),
    path: [],
    seq: 0,
    decodes: index % cfg.sampleEvery === 0,
    pingPhase: index % PING_EVERY,
    send: (bytes) => {
      const copy = Buffer.from(bytes);
      bot.up.delay(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(copy);
      });
    },
  };
  bots.push(bot);
  ws.on('open', () =>
    bot.send(
      encodeClient(
        { type: 'hello', version: PROTOCOL_VERSION, name: `Bot ${index}`, token: '' },
        writer,
      ),
    ),
  );
  ws.on('message', (data: Buffer) => {
    bot.down.delay(() => receive(bot, data));
  });
  ws.on('error', () => {
    report.errors += 1;
  });
  ws.on('close', () => {
    if (bot.ready) report.connected -= 1;
    bot.ready = false;
  });
}

function receive(bot: Bot, data: Buffer) {
  report.bytesIn += data.byteLength;
  report.framesIn += 1;
  // Tick frames (view changes + snapshot) are only decoded by the sampling bots.
  const type = data[0];
  const tickFrame =
    type === S2C.SNAPSHOT || type === S2C.ENTER || type === S2C.LEAVE || type === S2C.SEAT;
  if (tickFrame && !bot.decodes) return;
  for (const m of decodeServerFrame(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  )) {
    switch (m.type) {
      case 'welcome':
        bot.ready = true;
        report.connected += 1;
        bot.x = m.spawn.x;
        bot.z = m.spawn.z;
        break;
      case 'correction':
        report.corrections += 1;
        bot.x = m.x;
        bot.z = m.z;
        bot.path.length = 0;
        break;
      case 'pong':
        report.rtts.push(performance.now() - m.clientTime);
        break;
      case 'snapshot':
        report.snapshotEntities += m.entities.length;
        report.snapshotsDecoded += 1;
        break;
      case 'error':
        report.errors += 1;
        break;
      default:
        break;
    }
  }
}

const dt = 1 / CLIENT_SEND_HZ;
let tickNo = 0;
setInterval(() => {
  tickNo += 1;
  for (const bot of bots) {
    if (!bot.ready) continue;
    if (bot.path.length === 0) (cfg.scenario === 'crowd' ? planCrowd : planSpread)(bot);
    const target = bot.path[0];
    let vx = 0;
    let vz = 0;
    if (target) {
      const dx = target.x - bot.x;
      const dz = target.z - bot.z;
      const dist = Math.hypot(dx, dz);
      const step = bot.speed * dt;
      if (dist <= step) {
        bot.x = target.x;
        bot.z = target.z;
        bot.path.shift();
      } else {
        vx = (dx / dist) * bot.speed;
        vz = (dz / dist) * bot.speed;
        bot.x += vx * dt;
        bot.z += vz * dt;
        bot.yaw = Math.atan2(vx, vz);
      }
    }
    bot.seq = (bot.seq + 1) & 0xffff;
    const state = vx === 0 && vz === 0 ? MODE.IDLE : bot.speed > 3 ? MODE.RUN : MODE.WALK;
    bot.send(
      encodeClient(
        {
          type: 'state',
          seq: bot.seq,
          x: bot.x,
          y: 0,
          z: bot.z,
          yaw: bot.yaw,
          vx,
          vy: 0,
          vz,
          state,
        },
        writer,
      ),
    );
    if (tickNo % PING_EVERY === bot.pingPhase) {
      bot.send(encodeClient({ type: 'ping', clientTime: performance.now() }, writer));
    }
  }
}, dt * 1000);

// Ramp up: connect bots at the configured rate.
let started = 0;
const ramp = setInterval(() => {
  const batch = Math.max(1, Math.round(cfg.rampPerSecond / 10));
  for (let i = 0; i < batch && started < cfg.bots; i += 1) connect(cfg.firstBot + started++);
  if (started >= cfg.bots) clearInterval(ramp);
}, 100);

setInterval(() => {
  parentPort?.postMessage({ ...report });
  report.bytesIn = 0;
  report.framesIn = 0;
  report.snapshotEntities = 0;
  report.snapshotsDecoded = 0;
  report.corrections = 0;
  report.errors = 0;
  report.rtts = [];
}, 2000);

parentPort?.on('message', (msg) => {
  if (msg === 'stop') {
    for (const bot of bots) bot.ws.terminate();
    process.exit(0);
  }
});
