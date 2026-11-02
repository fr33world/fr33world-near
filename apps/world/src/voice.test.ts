import {
  decodeServerFrame,
  encodeClient,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@fr33world/protocol';
import { describe, expect, it } from 'vitest';
import type { Conn } from './transport.ts';
import { liveKitVoice, VOICE_ROOM } from './voice.ts';
import { World } from './world.ts';

class FakeConn implements Conn {
  static next = 9000;
  readonly id = FakeConn.next++;
  readonly remote = 'test';
  readonly inbox: ServerMessage[] = [];
  send(bytes: Uint8Array) {
    this.inbox.push(...decodeServerFrame(new Uint8Array(bytes)));
  }
  buffered() {
    return 0;
  }
  close() {}
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('proximity voice passes', () => {
  it('follow the welcome, one per player, named by entity id', async () => {
    const issued: number[] = [];
    const world = new World({
      voice: (id) => {
        issued.push(id);
        return Promise.resolve({ url: 'ws://voice.test', token: `t${id}` });
      },
    });
    const conn = new FakeConn();
    world.open(conn);
    world.message(
      conn,
      encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: 'Ada', token: '' }),
    );
    await settle();
    const welcome = conn.inbox.find((m) => m.type === 'welcome');
    const voice = conn.inbox.find((m) => m.type === 'voice');
    if (welcome?.type !== 'welcome') throw new Error('no welcome');
    expect(conn.inbox.indexOf(welcome)).toBeLessThan(conn.inbox.indexOf(voice as ServerMessage));
    expect(voice).toEqual({ type: 'voice', url: 'ws://voice.test', token: `t${welcome.you}` });
    expect(issued).toEqual([welcome.you]);
  });

  it('are LiveKit tokens for the shared room, publish and subscribe only', async () => {
    const pass = await liveKitVoice('ws://localhost:7880', 'devkey', 'secret')(42, 'Ada');
    const payload = JSON.parse(
      Buffer.from(pass.token.split('.')[1] ?? '', 'base64url').toString(),
    ) as { sub: string; name: string; video: object; exp: number; nbf: number };
    expect(payload.sub).toBe('p42');
    expect(payload.name).toBe('Ada');
    expect(payload.video).toMatchObject({
      room: VOICE_ROOM,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(payload.exp - payload.nbf).toBe(6 * 3600);
  });
});
