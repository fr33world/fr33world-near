/**
 * The world server's small HTTP API, served on the WebSocket's port (Render gives a web
 * service one public port):
 *
 *   GET /health   "ok" for the host's health checks
 *   GET /status   players online, capacity, tick rate, login mode, game clock (JSON, CORS open)
 *
 * The client calls /status before connecting: on Render's free plan the first request wakes a
 * sleeping server, and the login screen shows who's online. Game traffic stays on the
 * WebSocket (any path; clients use /ws).
 */
import { PROTOCOL_VERSION } from '@fr33world/protocol';
import { formatClock } from '@fr33world/shared';
import type { HttpReply } from './transport.ts';
import type { World } from './world.ts';

export interface ServerInfo {
  tickHz: number;
  /** 'required': players must log in; 'checked': tokens verified when given; 'off': not checked. */
  login: 'required' | 'checked' | 'off';
  /** Deploy profile name, e.g. 'free'. */
  profile: string;
  /** Proximity voice is configured (players get LiveKit passes). */
  voice: boolean;
}

export interface Status {
  name: string;
  protocol: number;
  players: number;
  capacity: number;
  tickHz: number;
  login: ServerInfo['login'];
  profile: string;
  voice: boolean;
  uptimeS: number;
  gameTime: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'cache-control': 'no-store',
};

export function statusOf(world: World, info: ServerInfo): Status {
  return {
    // The server's name (the city is Los Soles; more servers would each have their own).
    name: 'Horizon',
    protocol: PROTOCOL_VERSION,
    players: world.playerCount,
    capacity: world.capacity,
    tickHz: info.tickHz,
    login: info.login,
    profile: info.profile,
    voice: info.voice,
    uptimeS: Math.round(world.serverTime() / 1000),
    gameTime: formatClock(world.gameMinutes()),
  };
}

export function httpApi(
  world: World,
  info: ServerInfo,
): (method: string, path: string) => HttpReply {
  return (method, path) => {
    if (method === 'OPTIONS') return { status: 204, type: 'text/plain', body: '', headers: CORS };
    if (method !== 'GET' && method !== 'HEAD') return json(405, { error: 'method not allowed' });
    if (path === '/health') return { status: 200, type: 'text/plain', body: 'ok', headers: CORS };
    if (path === '/status' || path === '/') return json(200, statusOf(world, info));
    return json(404, { error: 'not found' });
  };
}

function json(status: number, body: unknown): HttpReply {
  return { status, type: 'application/json', body: JSON.stringify(body), headers: CORS };
}
