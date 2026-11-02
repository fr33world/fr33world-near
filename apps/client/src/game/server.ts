/**
 * Where the world server is, and its HTTP API (apps/world/src/api.ts). On Render's free plan
 * the server sleeps after 15 idle minutes and takes about a minute to wake, so the client asks
 * /status (which wakes it) as soon as the page opens and keeps asking until it answers.
 */

export interface ServerStatus {
  name: string;
  protocol: number;
  players: number;
  capacity: number;
  tickHz: number;
  login: 'required' | 'checked' | 'off';
  profile: string;
  voice: boolean;
  uptimeS: number;
  gameTime: string;
}

/** `?server=` beats the build's VITE_WORLD_URL, which beats this host on port 7400 (dev). */
export function worldUrl(): string {
  const param = new URLSearchParams(location.search).get('server');
  const built = import.meta.env.VITE_WORLD_URL as string | undefined;
  return param ?? (built || `ws://${location.hostname}:7400/ws`);
}

/** ws://host/ws → http://host/status (wss → https). */
export function statusUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/status';
  url.search = '';
  return url.toString();
}

export async function fetchStatus(wsUrl = worldUrl(), timeoutMs = 8000): Promise<ServerStatus> {
  const res = await fetch(statusUrl(wsUrl), {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  // While waking, the host may answer with its own loading page instead of our JSON.
  const status = (await res.json()) as ServerStatus;
  if (typeof status.protocol !== 'number') throw new Error('not a world server');
  return status;
}

const WAKE_DEADLINE_MS = 120_000;
const WAKE_RETRY_MS = 3000;
let waking: Promise<ServerStatus> | null = null;
let slow = false;
const waiters = new Set<() => void>();

/**
 * Resolves once the server answers /status, retrying through a cold start. Concurrent callers
 * share one wake-up; `onWaiting` runs once the first try has failed (to say "waking the
 * server"), immediately if that already happened.
 */
export function wakeServer(wsUrl = worldUrl(), onWaiting?: () => void): Promise<ServerStatus> {
  if (onWaiting) {
    if (waking && slow) onWaiting();
    else waiters.add(onWaiting);
  }
  waking ??= attempt(wsUrl).finally(() => {
    waking = null;
    slow = false;
    waiters.clear();
  });
  return waking;
}

async function attempt(wsUrl: string): Promise<ServerStatus> {
  const deadline = performance.now() + WAKE_DEADLINE_MS;
  for (;;) {
    try {
      return await fetchStatus(wsUrl, 15_000);
    } catch (e) {
      if (performance.now() > deadline)
        throw new Error('The server is not answering', { cause: e });
      if (!slow) {
        slow = true;
        for (const w of waiters) w();
      }
      await new Promise((r) => setTimeout(r, WAKE_RETRY_MS));
    }
  }
}
