/**
 * Horizon world server: the game WebSocket and a small HTTP API (api.ts) on one port.
 * Environment:
 *   PORT           listen port (default 7400; Render sets it)
 *   WORLD_PROFILE  default | free (Render's free plan: 0.1 CPU and 5 GB of traffic a month,
 *                  so 50 players at 20 Hz; decision D-31)
 *   MAX_PLAYERS    session cap (profile default: 500, free 50)
 *   TICK_HZ        simulation and snapshot rate (profile default: 30, free 20)
 *   TRANSPORT      uws | ws (default uws, decision D-25; falls back to ws where uWebSockets.js
 *                  can't load, e.g. Render's Debian 12, whose glibc is older than it needs)
 *   STATS_FILE     optional path; stats lines are appended as JSON
 *   WORLD_TICKET_SECRET              verify world tickets from the API. When set, tickets are the
 *                                    only accepted login (they prove the 18+ onboarding)
 *   PRIVY_APP_ID, PRIVY_APP_SECRET   accept raw Privy tokens instead, only without a ticket
 *                                    secret (local play without the API)
 *   WORLD_AUTH     required | optional (default optional: dev bots may join without a login)
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET   proximity voice (voice.ts); unset = off
 *   API_URL        the API, for staff commands that last (bans, admins) and the audit log; it
 *                  trusts the world by a key derived from WORLD_TICKET_SECRET. Unset = those off
 */
import { appendFileSync } from 'node:fs';
import { isPermission, TICK_HZ } from '@fr33world/shared';
import { httpApi } from './api.ts';
import { internalKey, privyVerifier, verifyTicket } from '@fr33world/auth';
import { liveKitVoice } from './voice.ts';
import type { Transport } from './transport.ts';
import { WsTransport } from './transport-ws.ts';
import { World, type WorldOptions } from './world.ts';

const PROFILES = {
  default: { maxPlayers: 500, tickHz: TICK_HZ },
  free: { maxPlayers: 50, tickHz: 20 },
} as const;

const profileName = process.env.WORLD_PROFILE ?? 'default';
if (!(profileName in PROFILES)) throw new Error(`unknown WORLD_PROFILE ${profileName}`);
const profile = PROFILES[profileName as keyof typeof PROFILES];
const port = Number(process.env.PORT ?? 7400);
const transportName = process.env.TRANSPORT ?? 'uws';
const maxPlayers = Number(process.env.MAX_PLAYERS ?? profile.maxPlayers);
const tickHz = Number(process.env.TICK_HZ ?? profile.tickHz);
const statsFile = process.env.STATS_FILE;

const transport: Transport = await pickTransport(transportName);
const { PRIVY_APP_ID, PRIVY_APP_SECRET, WORLD_TICKET_SECRET } = process.env;
const requireAuth = process.env.WORLD_AUTH === 'required';
const privy =
  PRIVY_APP_ID && PRIVY_APP_SECRET ? privyVerifier(PRIVY_APP_ID, PRIVY_APP_SECRET) : undefined;
const ticketSecret = WORLD_TICKET_SECRET;
const authenticate: WorldOptions['authenticate'] = ticketSecret
  ? (token) => {
      const t = verifyTicket(ticketSecret, token);
      return Promise.resolve(
        t
          ? {
              account: t.account,
              name: t.name,
              look: t.look,
              gear: t.gear,
              xp: t.xp,
              staff: t.staff && {
                role: t.staff.role,
                permissions: t.staff.permissions.filter(isPermission),
              },
            }
          : null,
      );
    }
  : privy
    ? async (token) => {
        const user = await privy(token);
        return user ? { account: user } : null;
      }
    : undefined;
if (requireAuth && !authenticate)
  throw new Error('WORLD_AUTH=required needs WORLD_TICKET_SECRET or the Privy keys');
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const voice =
  LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    ? liveKitVoice(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    : undefined;
const { API_URL } = process.env;
const staffApi: WorldOptions['staffApi'] =
  API_URL && ticketSecret
    ? async (path, body) => {
        const res = await fetch(`${API_URL}/v1/internal/${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${internalKey(ticketSecret)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        // The status goes with it: jobs retry a pay the API couldn't take (5xx), not one it
        // turned down (4xx).
        if (!res.ok)
          throw Object.assign(new Error(data.error ?? `The API said ${res.status}.`), {
            status: res.status,
          });
        return data;
      }
    : undefined;
const world = new World({ maxPlayers, tickHz, authenticate, requireAuth, voice, staffApi });
const login = authenticate ? (requireAuth ? 'required' : 'checked') : 'off';

const bound = await transport.listen(port, {
  request: httpApi(world, { tickHz, login, profile: profileName, voice: Boolean(voice) }),
  open: (conn) => world.open(conn),
  message: (conn, bytes) => world.message(conn, bytes),
  close: (conn) => world.close(conn),
});
const auth = {
  required: 'login required',
  checked: 'login checked when given',
  off: 'no login check',
}[login];
console.log(
  `horizon world on :${bound} (${transport.name}, ${profileName} profile, ${tickHz} Hz, ` +
    `max ${maxPlayers} players, ${auth}, voice ${voice ? LIVEKIT_URL : 'off'})`,
);

// Fixed-rate loop that schedules against the ideal timeline, so ticks don't drift. If the
// process falls far behind (a GC pause, a busy machine), it skips ahead instead of bursting.
const period = 1000 / tickHz;
let next = performance.now();
let lateTicks = 0;
const loop = () => {
  world.step();
  next += period;
  const now = performance.now();
  if (now - next > period * 5) {
    lateTicks += Math.floor((now - next) / period);
    next = now;
  }
  setTimeout(loop, Math.max(0, next - now));
};
setTimeout(loop, period);

let lastCpu = process.cpuUsage();
let lastAt = performance.now();
let quietLines = 0;
setInterval(() => {
  const cpu = process.cpuUsage(lastCpu);
  const at = performance.now();
  const seconds = (at - lastAt) / 1000;
  lastCpu = process.cpuUsage();
  lastAt = at;
  const s = world.stats();
  const line = {
    t: new Date().toISOString(),
    transport: transport.name,
    ...s,
    tickHz: +(s.ticks / seconds).toFixed(1),
    lateTicks,
    cpuPct: +(((cpu.user + cpu.system) / 1000 / (seconds * 1000)) * 100).toFixed(1),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    outKBps: Math.round(s.bytesOut / 1024 / seconds),
    perPlayerOutKBps: s.players ? +(s.bytesOut / 1024 / seconds / s.players).toFixed(2) : 0,
    inMsgPerS: Math.round(s.messagesIn / seconds),
  };
  lateTicks = 0;
  // An empty server logs once a minute instead of every 5 s (host log volume).
  quietLines = s.players === 0 ? quietLines + 1 : 0;
  if (quietLines > 1 && quietLines % 12 !== 0) return;
  console.log(JSON.stringify(line));
  if (statsFile) appendFileSync(statsFile, JSON.stringify(line) + '\n');
}, 5000);

const shutdown = () => {
  // Everyone's place first, however long the API takes to say so (Render allows half a minute).
  const saved = Promise.race([world.saveAllPlaces(), new Promise((r) => setTimeout(r, 5000))]);
  void saved.then(() => transport.stop()).then(() => process.exit(0));
};
// A stray rejection is logged (Render keeps the logs), not left to crash the world.
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGTERM', shutdown);

/** uWebSockets.js when it loads (native, needs glibc 2.38+ on Linux), else `ws`. */
async function pickTransport(name: string): Promise<Transport> {
  if (name === 'ws') return new WsTransport();
  try {
    const { UwsTransport } = await import('./transport-uws.ts');
    return new UwsTransport();
  } catch (e) {
    console.warn(
      `uWebSockets.js can't load here (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); using ws`,
    );
    return new WsTransport();
  }
}
