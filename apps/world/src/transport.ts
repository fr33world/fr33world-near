/**
 * The world server talks to clients through this small interface so the WebSocket library is
 * swappable (decision D-25: `ws` and `uWebSockets.js` are benchmarked with the same world).
 */
export interface Conn {
  readonly id: number;
  readonly remote: string;
  /** Sends one binary frame. The bytes may be reused by the caller right after the call. */
  send(bytes: Uint8Array): void;
  /** Bytes queued but not yet written to the socket (for skipping snapshots to slow clients). */
  buffered(): number;
  close(code?: number, reason?: string): void;
}

/** A plain HTTP answer (the server's small JSON API: health checks, status). */
export interface HttpReply {
  status: number;
  type: string;
  body: string;
  headers?: Record<string, string>;
}

export interface TransportHandlers {
  /**
   * Plain HTTP requests on the same port as the WebSocket (hosts like Render route one public
   * port per service). Called synchronously; `path` excludes the query string.
   */
  request(method: string, path: string): HttpReply;
  open(conn: Conn): void;
  /** `bytes` is valid only during the call. */
  message(conn: Conn, bytes: Uint8Array): void;
  close(conn: Conn): void;
}

export interface Transport {
  readonly name: string;
  listen(port: number, handlers: TransportHandlers): Promise<number>;
  stop(): Promise<void>;
}

/** Largest client frame accepted; every client message is far smaller. */
export const MAX_FRAME = 1024;
