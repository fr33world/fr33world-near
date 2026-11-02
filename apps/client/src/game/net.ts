/**
 * Connection to the Horizon world server. Sends the local body's pose at CLIENT_SEND_HZ,
 * keeps a smoothed estimate of server time (for interpolating others), and hands every
 * decoded message to the game.
 */
import {
  type ClientMessage,
  decodeServerFrame,
  encodeClient,
  type Pose,
  PROTOCOL_VERSION,
  type ServerMessage,
  Writer,
} from '@fr33world/protocol';

export type Welcome = Extract<ServerMessage, { type: 'welcome' }>;

/** The server answered the hello with an error (ERROR_CODE), rather than being unreachable. */
export class ServerRefused extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

const PING_EVERY_MS = 2000;
/** Round trips the ping is taken from (8 s of them). */
const RTT_WINDOW = 4;

export class NetClient {
  you = -1;
  /**
   * Round-trip time in ms: the lowest of the last few. A pong waits for the frame being drawn, and
   * for the whole of a long one, so anything above that is this device being busy, not the
   * network. Smoothed instead, one stall on entering the city showed a red ping for half a minute.
   */
  rtt = 0;
  connected = false;
  onMessage: (m: ServerMessage) => void = () => {};
  /** The socket closed after a welcome. Codes 4000+ are the server's decision (see world.ts). */
  onClose: (reason: string, code: number) => void = () => {};

  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly writer = new Writer(64);
  /** serverTime ≈ performance.now() + offset. */
  private offset = 0;
  private bestRtt = Infinity;
  private readonly recentRtt: number[] = [];
  private pingTimer = 0;

  /**
   * Opens the socket and resolves with the server's welcome. `token` is the player's login
   * token ('' to play without a login in dev).
   */
  connect(url: string, name: string, token: string, timeoutMs = 8000): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let welcomed = false;
      const timer = setTimeout(() => {
        if (!welcomed) {
          ws.close();
          reject(new Error('The server did not answer in time'));
        }
      }, timeoutMs);
      ws.onopen = () => this.send({ type: 'hello', version: PROTOCOL_VERSION, name, token });
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        for (const m of decodeServerFrame(new Uint8Array(e.data))) {
          if (m.type === 'welcome' && !welcomed) {
            welcomed = true;
            clearTimeout(timer);
            this.you = m.you;
            this.connected = true;
            this.offset = m.serverTime - performance.now();
            this.pingTimer = window.setInterval(() => this.ping(), PING_EVERY_MS);
            this.ping();
            resolve(m);
            continue;
          }
          if (m.type === 'pong') this.onPong(m.clientTime, m.serverTime);
          if (m.type === 'error' && !welcomed) {
            clearTimeout(timer);
            reject(new ServerRefused(m.message, m.code));
          }
          this.onMessage(m);
        }
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        window.clearInterval(this.pingTimer);
        const was = this.connected;
        this.connected = false;
        if (!welcomed) reject(new Error(e.reason || 'Could not reach the server'));
        else if (was) this.onClose(e.reason || 'Disconnected', e.code);
      };
    });
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    this.ws?.close();
  }

  /** Server time now, in the world's milliseconds. */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  sendState(pose: Pose): void {
    this.seq = (this.seq + 1) & 0xffff;
    this.send({ type: 'state', seq: this.seq, ...pose });
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(m, this.writer));
  }

  private ping() {
    this.send({ type: 'ping', clientTime: performance.now() });
  }

  /**
   * Clock sync: trust samples with the lowest round trip most (they had the least queueing),
   * and nudge the offset slowly otherwise so interpolation never jumps.
   */
  private onPong(clientTime: number, serverTime: number) {
    const now = performance.now();
    const rtt = now - clientTime;
    this.recentRtt.push(rtt);
    if (this.recentRtt.length > RTT_WINDOW) this.recentRtt.shift();
    this.rtt = Math.min(...this.recentRtt);
    const sample = serverTime + rtt / 2 - now;
    if (rtt <= this.bestRtt * 1.2) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      this.offset = this.offset * 0.5 + sample * 0.5;
    } else {
      this.offset = this.offset * 0.95 + sample * 0.05;
    }
  }
}
