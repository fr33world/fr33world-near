import { createRequire } from 'node:module';
import type * as UWS from 'uWebSockets.js';
import {
  type Conn,
  type HttpReply,
  MAX_FRAME,
  type Transport,
  type TransportHandlers,
} from './transport.ts';

// v20.71.0's ESM wrapper imports a file the package doesn't ship; the CommonJS entry works.
const uWS = createRequire(import.meta.url)('uWebSockets.js') as typeof UWS;

interface SocketData {
  conn: Conn | null;
  /** Set before end() and on close: a closed uWS socket must never be touched again. */
  closed: boolean;
}

/** Transport on uWebSockets.js (native, lower CPU and memory per connection). */
export class UwsTransport implements Transport {
  readonly name = 'uws';
  private socket: UWS.us_listen_socket | null = null;

  listen(port: number, handlers: TransportHandlers): Promise<number> {
    let nextId = 1;
    const app = uWS.App();
    // Plain HTTP (the API). Registered before the WebSocket route: uWS sends upgrades to the
    // WebSocket route either way, but plain requests only reach a catch-all registered first.
    app.any('/*', (res, req) => {
      const reply = handlers.request(req.getMethod().toUpperCase(), req.getUrl());
      res.cork(() => {
        res.writeStatus(statusLine(reply));
        res.writeHeader('content-type', reply.type);
        for (const [k, v] of Object.entries(reply.headers ?? {})) res.writeHeader(k, v);
        res.end(reply.body);
      });
    });
    app.ws<SocketData>('/*', {
      compression: uWS.DISABLED,
      maxPayloadLength: MAX_FRAME,
      idleTimeout: 60,
      maxBackpressure: 4 * 1024 * 1024,
      upgrade: (res, req, context) => {
        res.upgrade<SocketData>(
          { conn: null, closed: false },
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          context,
        );
      },
      open: (ws) => {
        const data = ws.getUserData();
        const conn: Conn = {
          id: nextId++,
          remote: Buffer.from(ws.getRemoteAddressAsText()).toString(),
          // uWS copies into its own send buffer synchronously.
          send: (bytes) => {
            if (!data.closed) ws.send(bytes, true);
          },
          buffered: () => (data.closed ? 0 : ws.getBufferedAmount()),
          close: (code, reason) => {
            if (data.closed) return;
            data.closed = true;
            ws.end(code ?? 1000, reason);
          },
        };
        data.conn = conn;
        handlers.open(conn);
      },
      message: (ws, message, isBinary) => {
        const conn = ws.getUserData().conn;
        if (!conn) return;
        if (!isBinary) return conn.close(1003, 'binary only');
        handlers.message(conn, new Uint8Array(message));
      },
      close: (ws) => {
        const data = ws.getUserData();
        data.closed = true;
        if (data.conn) handlers.close(data.conn);
      },
    });
    return new Promise((resolve, reject) => {
      app.listen(port, (token) => {
        if (!token) return reject(new Error(`uWS could not listen on ${port}`));
        this.socket = token;
        resolve(uWS.us_socket_local_port(token));
      });
    });
  }

  stop(): Promise<void> {
    if (this.socket) uWS.us_listen_socket_close(this.socket);
    this.socket = null;
    return Promise.resolve();
  }
}

const REASONS: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  404: 'Not Found',
  405: 'Method Not Allowed',
};

function statusLine(reply: HttpReply): string {
  return `${reply.status} ${REASONS[reply.status] ?? ''}`.trim();
}
