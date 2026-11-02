/**
 * Load test: starts a world server, connects bots, and summarises server cost and client
 * experience over a steady window after the ramp. Environment:
 *   TRANSPORT ws|uws   BOTS 500   SCENARIO spread|crowd   DURATION 60 (s, after ramp)
 *   WORKERS 2          RAMP 50 (bots/s)                   PORT 7420
 *   LATENCY 75 (one-way ms)  JITTER 15 (ms)  LOSS 0.02
 * Writes load-runs/<stamp>-<transport>-<scenario>-<bots>.json at the repo root.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerConfig, WorkerReport } from './bot-worker.ts';

const env = process.env;
const transport = env.TRANSPORT ?? 'ws';
const totalBots = Number(env.BOTS ?? 500);
const scenario = (env.SCENARIO ?? 'spread') as WorkerConfig['scenario'];
const durationS = Number(env.DURATION ?? 60);
const workers = Number(env.WORKERS ?? 2);
const ramp = Number(env.RAMP ?? 50);
const port = Number(env.PORT ?? 7420);
const latencyMs = Number(env.LATENCY ?? 75);
const jitterMs = Number(env.JITTER ?? 15);
const loss = Number(env.LOSS ?? 0.02);

const root = new URL('../../../../', import.meta.url).pathname;
const outDir = join(root, 'load-runs');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = `${stamp}-${transport}-${scenario}-${totalBots}`;
const statsFile = join(outDir, `${base}-server.jsonl`);

const server = spawn(process.execPath, [new URL('../main.ts', import.meta.url).pathname], {
  env: {
    ...env,
    PORT: String(port),
    TRANSPORT: transport,
    MAX_PLAYERS: String(totalBots + 10),
    STATS_FILE: statsFile,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((resolve, reject) => {
  server.stdout.on('data', (d: Buffer) => {
    if (d.toString().includes('horizon world on')) resolve();
  });
  server.once('exit', (code) => reject(new Error(`server exited ${code}`)));
});
console.log(`server up (${transport}); ${totalBots} bots, ${scenario}, ${workers} workers`);

const rampS = Math.ceil(totalBots / ramp) + 5;
const rampEndsAt = Date.now() + rampS * 1000;
const reports = new Map<number, WorkerReport>();
const steady = {
  bytesIn: 0,
  framesIn: 0,
  entities: 0,
  decoded: 0,
  corrections: 0,
  errors: 0,
  seconds: 0,
};
const rtts: number[] = [];
let lastConnected = 0;

const pool: Worker[] = [];
const perWorker = Math.ceil(totalBots / workers);
for (let w = 0; w < workers; w += 1) {
  const bots = Math.min(perWorker, totalBots - w * perWorker);
  if (bots <= 0) break;
  const config: WorkerConfig = {
    url: `ws://127.0.0.1:${port}`,
    firstBot: w * perWorker,
    bots,
    rampPerSecond: ramp / workers,
    scenario,
    latencyMs,
    jitterMs,
    loss,
    sampleEvery: 10,
  };
  const worker = new Worker(new URL('./bot-worker.ts', import.meta.url), { workerData: config });
  worker.on('message', (r: WorkerReport) => {
    reports.set(w, r);
    if (Date.now() < rampEndsAt) return;
    steady.bytesIn += r.bytesIn;
    steady.framesIn += r.framesIn;
    steady.entities += r.snapshotEntities;
    steady.decoded += r.snapshotsDecoded;
    steady.corrections += r.corrections;
    steady.errors += r.errors;
    for (const t of r.rtts) rtts.push(t);
  });
  worker.on('error', (e) => console.error('worker error', e));
  pool.push(worker);
}

const progress = setInterval(() => {
  lastConnected = [...reports.values()].reduce((n, r) => n + r.connected, 0);
  const phase = Date.now() < rampEndsAt ? 'ramp' : 'steady';
  console.log(`${phase}: ${lastConnected} bots connected`);
}, 5000);

await new Promise((r) => setTimeout(r, (rampS + durationS) * 1000));
clearInterval(progress);
steady.seconds = durationS;
for (const w of pool) w.postMessage('stop');
server.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));

const lines = readFileSync(statsFile, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Record<string, number>);
const steadyLines = lines.slice(Math.ceil(rampS / 5));
const avg = (key: string) =>
  steadyLines.reduce((s, l) => s + (l[key] ?? 0), 0) / Math.max(1, steadyLines.length);
const max = (key: string) => Math.max(...steadyLines.map((l) => l[key] ?? 0));
const sorted = rtts.sort((a, b) => a - b);
const pct = (q: number) =>
  +(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(1);
const botSeconds = Math.max(1, lastConnected * steady.seconds);

const summary = {
  when: new Date().toISOString(),
  transport,
  scenario,
  bots: totalBots,
  connected: lastConnected,
  network: { latencyMsOneWay: latencyMs, jitterMs, loss },
  server: {
    tickHz: +avg('tickHz').toFixed(1),
    tickMsP50: +avg('tickMsP50').toFixed(2),
    tickMsP95: +avg('tickMsP95').toFixed(2),
    tickMsP99: +avg('tickMsP99').toFixed(2),
    tickMsMax: +max('tickMsMax').toFixed(2),
    cpuPct: +avg('cpuPct').toFixed(1),
    rssMB: max('rssMB'),
    outKBps: Math.round(avg('outKBps')),
    perPlayerOutKBps: +avg('perPlayerOutKBps').toFixed(2),
    inMsgPerS: Math.round(avg('inMsgPerS')),
    lateTicks: steadyLines.reduce((s, l) => s + (l.lateTicks ?? 0), 0),
    corrections: steadyLines.reduce((s, l) => s + (l.corrections ?? 0), 0),
    skippedSlow: steadyLines.reduce((s, l) => s + (l.skippedSlow ?? 0), 0),
  },
  client: {
    inKBpsPerBot: +(steady.bytesIn / 1024 / botSeconds).toFixed(2),
    framesPerSecPerBot: +(steady.framesIn / botSeconds).toFixed(1),
    avgEntitiesPerSnapshot: +(steady.entities / Math.max(1, steady.decoded)).toFixed(1),
    rttMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), samples: sorted.length },
    correctionsReceived: steady.corrections,
    errors: steady.errors,
  },
};
writeFileSync(join(outDir, `${base}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
