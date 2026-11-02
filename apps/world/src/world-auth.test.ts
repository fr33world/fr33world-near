import {
  decodeServerFrame,
  encodeClient,
  ERROR_CODE,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@fr33world/protocol';
import { decodeAppearance, DEFAULT_APPEARANCE, encodeAppearance } from '@fr33world/shared';
import { describe, expect, it } from 'vitest';
import type { Conn } from './transport.ts';
import { World } from './world.ts';

class FakeConn implements Conn {
  static next = 5000;
  readonly id = FakeConn.next++;
  readonly remote = 'test';
  readonly inbox: ServerMessage[] = [];
  closed = false;
  send(bytes: Uint8Array) {
    this.inbox.push(...decodeServerFrame(new Uint8Array(bytes)));
  }
  buffered() {
    return 0;
  }
  close() {
    this.closed = true;
  }
}

/** Tokens "good-<account>" verify as <account>; anything else is rejected. */
const authenticate = (token: string) =>
  Promise.resolve(token.startsWith('good-') ? { account: token.slice(5) } : null);

function hello(world: World, token: string) {
  const conn = new FakeConn();
  world.open(conn);
  world.message(conn, encodeClient({ type: 'hello', version: PROTOCOL_VERSION, name: 'P', token }));
  return conn;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('login on connect', () => {
  it('welcomes a verified token and refuses a bad one', async () => {
    const world = new World({ authenticate });
    const ok = hello(world, 'good-alice');
    const bad = hello(world, 'forged');
    await settle();
    expect(ok.inbox.some((m) => m.type === 'welcome')).toBe(true);
    expect(bad.inbox).toContainEqual(
      expect.objectContaining({ type: 'error', code: ERROR_CODE.UNAUTHORIZED }),
    );
    expect(bad.closed).toBe(true);
  });

  it('refuses players without a token when login is required', () => {
    const world = new World({ authenticate, requireAuth: true });
    const anon = hello(world, '');
    expect(anon.inbox).toContainEqual(
      expect.objectContaining({ type: 'error', code: ERROR_CODE.UNAUTHORIZED }),
    );
  });

  it('lets anonymous players in when login is optional (dev bots)', () => {
    const world = new World({ authenticate });
    const anon = hello(world, '');
    expect(anon.inbox.some((m) => m.type === 'welcome')).toBe(true);
  });

  it('keeps one session per account: a second login ends the first', async () => {
    const world = new World({ authenticate });
    const first = hello(world, 'good-bob');
    await settle();
    const second = hello(world, 'good-bob');
    await settle();
    expect(first.closed).toBe(true);
    expect(second.inbox.some((m) => m.type === 'welcome')).toBe(true);
    expect(world.playerCount).toBe(1);
  });
});

describe('world tickets', () => {
  it('name players by their account, not by what the client typed', async () => {
    // Tokens "acct:<id>:<name>" stand in for verified tickets.
    const world = new World({
      authenticate: (t) => {
        const [, account, name] = t.split(':');
        return Promise.resolve(account && name ? { account, name } : null);
      },
    });
    const a = hello(world, 'acct:a:Ada');
    const b = hello(world, 'acct:b:Bo');
    await settle();
    world.step();
    const seenByA = a.inbox.find((m) => m.type === 'enter' && m.kind === 0);
    // hello() always types the name "P"; the ticket's name wins.
    expect(seenByA).toMatchObject({ name: 'Bo' });
    expect(b.inbox.find((m) => m.type === 'enter' && m.kind === 0)).toMatchObject({ name: 'Ada' });
  });
});

describe('appearance', () => {
  it("shows other players each player's character: the ticket's name and look", async () => {
    const look = encodeAppearance({
      ...DEFAULT_APPEARANCE,
      body: 'female',
      face: 3,
      outfit: 5,
      skin: 4,
      top: 2,
    });
    const world = new World({
      authenticate: (token) =>
        Promise.resolve(
          token === 'good-ada' ? { account: 'ada', name: 'Ada Byron', look } : { account: token },
        ),
    });
    const ada = hello(world, 'good-ada');
    const bo = hello(world, 'good-bo');
    await settle();
    expect(ada.inbox.some((m) => m.type === 'welcome')).toBe(true);
    world.step();
    const seen = bo.inbox.find((m) => m.type === 'enter' && m.name === 'Ada Byron');
    expect(seen).toMatchObject({ look });
    // Without a character (bot, local play): a valid made-up look.
    const other = ada.inbox.find((m) => m.type === 'enter' && m.kind === 0);
    expect(other && other.type === 'enter' && decodeAppearance(other.look)).toBeTruthy();
  });
});

describe('reconnecting', () => {
  it('keeps a dropped player 60 s and resumes them in place, as the same entity', async () => {
    let clock = 1_000_000;
    const world = new World({ authenticate, now: () => clock });
    const first = hello(world, 'good-cat');
    await settle();
    const welcome = first.inbox.find((m) => m.type === 'welcome');
    if (welcome?.type !== 'welcome') throw new Error('no welcome');
    world.message(
      first,
      encodeClient({
        type: 'state',
        seq: 1,
        ...welcome.spawn,
        x: welcome.spawn.x + 0.3,
      }),
    );
    world.close(first);
    // Still there (a ghost) for the others.
    world.step();
    expect(world.playerCount).toBe(1);
    clock += 30_000;
    const again = hello(world, 'good-cat');
    await settle();
    const resumed = again.inbox.find((m) => m.type === 'welcome');
    if (resumed?.type !== 'welcome') throw new Error('no welcome on resume');
    expect(resumed.you).toBe(welcome.you);
    expect(resumed.spawn.x).toBeCloseTo(welcome.spawn.x + 0.3, 1);
    expect(world.playerCount).toBe(1);
  });

  it('lets the ghost go after 60 s; a later login starts fresh', async () => {
    let clock = 1_000_000;
    const world = new World({ authenticate, now: () => clock });
    const first = hello(world, 'good-dee');
    await settle();
    world.close(first);
    clock += 61_000;
    world.step();
    expect(world.playerCount).toBe(0);
  });

  it('removes players without an account at once', () => {
    const world = new World({ authenticate });
    const anon = hello(world, '');
    world.close(anon);
    world.step();
    expect(world.playerCount).toBe(0);
  });
});
