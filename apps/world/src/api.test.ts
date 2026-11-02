import {
  decodeServerFrame,
  encodeClient,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@fr33world/protocol';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { httpApi, type Status } from './api.ts';
import type { Transport } from './transport.ts';
import { WsTransport } from './transport-ws.ts';
import { World } from './world.ts';

async function serve(transport: Transport) {
  const world = new World({ maxPlayers: 7 });
  const port = await transport.listen(0, {
    request: httpApi(world, { tickHz: 20, login: 'off', profile: 'free', voice: false }),
    open: (conn) => world.open(conn),
    message: (conn, bytes) => world.message(conn, bytes),
    close: (conn) => world.close(conn),
  });
  return { world, base: `127.0.0.1:${port}` };
}

function welcomeOver(url: string): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () =>
      ws.send(encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: 'Api', token: '' })),
    );
    ws.on('message', (data: Buffer) => {
      const first = decodeServerFrame(new Uint8Array(data))[0];
      ws.close();
      if (first) resolve(first);
    });
    ws.on('error', reject);
  });
}

// uWebSockets.js only where it loads (its Linux build needs glibc 2.38+).
const transports: [string, () => Transport][] = [['ws', () => new WsTransport()]];
try {
  const { UwsTransport } = await import('./transport-uws.ts');
  transports.unshift(['uws', () => new UwsTransport()]);
} catch (e) {
  console.warn('skipping uWebSockets.js:', e instanceof Error ? e.message.split('\n')[0] : e);
}

describe.each(transports)('HTTP API and WebSocket on one port (%s)', (_name, make) => {
  it('answers health, status and CORS preflight, and still takes game sockets', async () => {
    const transport = make();
    const { base } = await serve(transport);
    try {
      const health = await fetch(`http://${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('ok');

      const res = await fetch(`http://${base}/status?x=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const status = (await res.json()) as Status;
      expect(status).toMatchObject({ players: 0, capacity: 7, tickHz: 20, login: 'off' });
      expect(status.gameTime).toMatch(/^\d\d:\d\d$/);

      expect((await fetch(`http://${base}/status`, { method: 'OPTIONS' })).status).toBe(204);
      expect((await fetch(`http://${base}/nope`)).status).toBe(404);

      const welcome = await welcomeOver(`ws://${base}/ws`);
      expect(welcome.type).toBe('welcome');
    } finally {
      await transport.stop();
    }
  });
});
