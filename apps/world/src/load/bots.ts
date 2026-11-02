/**
 * Fills a running world server with bots for playtesting (unlike run.ts, which starts its own
 * server for a timed benchmark). Runs until Ctrl+C. Environment:
 *   SERVER_URL ws://127.0.0.1:7400/ws (or wss://…onrender.com/ws)   BOTS 100   SCENARIO crowd|spread   WORKERS 2
 *   LATENCY 0 (one-way ms)  JITTER 0  LOSS 0
 */
import { Worker } from 'node:worker_threads';
import type { WorkerConfig, WorkerReport } from './bot-worker.ts';

const env = process.env;
const url = env.SERVER_URL ?? 'ws://127.0.0.1:7400/ws';
const total = Number(env.BOTS ?? 100);
const scenario = (env.SCENARIO ?? 'crowd') as WorkerConfig['scenario'];
const workers = Math.max(1, Number(env.WORKERS ?? 2));

const reports = new Map<number, WorkerReport>();
const pool: Worker[] = [];
const per = Math.ceil(total / workers);
for (let w = 0; w < workers; w += 1) {
  const bots = Math.min(per, total - w * per);
  if (bots <= 0) break;
  const config: WorkerConfig = {
    url,
    firstBot: w * per,
    bots,
    rampPerSecond: 40 / workers,
    scenario,
    latencyMs: Number(env.LATENCY ?? 0),
    jitterMs: Number(env.JITTER ?? 0),
    loss: Number(env.LOSS ?? 0),
    sampleEvery: 1_000_000,
  };
  const worker = new Worker(new URL('./bot-worker.ts', import.meta.url), { workerData: config });
  worker.on('message', (r: WorkerReport) => reports.set(w, r));
  worker.on('error', (e: Error) => console.error('bot worker failed:', e.message));
  pool.push(worker);
}
console.log(`connecting ${total} bots (${scenario}) to ${url} — Ctrl+C to stop`);

setInterval(() => {
  const all = [...reports.values()];
  const connected = all.reduce((n, r) => n + r.connected, 0);
  const errors = all.reduce((n, r) => n + r.errors, 0);
  const rtts = all.flatMap((r) => r.rtts).sort((a, b) => a - b);
  const p50 = rtts.length ? rtts[Math.floor(rtts.length / 2)]?.toFixed(0) : '-';
  console.log(
    `${connected}/${total} bots connected · rtt p50 ${p50} ms${errors ? ` · ${errors} errors` : ''}`,
  );
  if (connected === 0 && errors > 0)
    console.log(`is the world server running at ${url}? (pnpm dev)`);
}, 5000);

const stop = () => {
  for (const w of pool) w.postMessage('stop');
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
