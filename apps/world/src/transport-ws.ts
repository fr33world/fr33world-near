import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { type Conn, MAX_FRAME, type Transport, type TransportHandlers } from './transport.ts';

/** Transport on the pure-JS `ws` library. */
export class WsTransport implements Transport {
  readonly name = 'ws';
  private server: WebSocketServer | null = null;
  private http: Server | null = null;

  listen(port: number, handlers: TransportHandlers): Promise<number> {
    let nextId = 1;
    const http = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const reply = handlers.request(req.method ?? 'GET', path);
      res.writeHead(reply.status, { 'content-type': reply.type, ...reply.headers });
      res.end(reply.body);
    });
    this.http = http;
    const server = new WebSocketServer({
      server: http,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME,
    });
    this.server = server;
    server.on('connection', (socket: WebSocket, req) => {
      socket.binaryType = 'nodebuffer';
      const conn: Conn = {
        id: nextId++,
        remote: req.socket.remoteAddress ?? '',
        // Buffer.from copies, so the caller's reusable encoder buffer is safe to overwrite.
        send: (bytes) => socket.send(Buffer.from(bytes), { binary: true }),
        buffered: () => socket.bufferedAmount,
        close: (code, reason) => socket.close(code ?? 1000, reason),
      };
      handlers.open(conn);
      socket.on('message', (data: Buffer, isBinary) => {
        if (!isBinary) return conn.close(1003, 'binary only');
        handlers.message(conn, data);
      });
      socket.on('close', () => handlers.close(conn));
      socket.on('error', () => socket.terminate());
    });
    return new Promise((resolve, reject) => {
      http.once('listening', () => resolve((http.address() as AddressInfo).port));
      http.once('error', reject);
      http.listen(port);
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    const http = this.http;
    if (!server || !http) return Promise.resolve();
    for (const client of server.clients) client.terminate();
    return new Promise((resolve) => server.close(() => http.close(() => resolve())));
  }
}
