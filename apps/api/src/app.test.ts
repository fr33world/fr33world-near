import { internalKey, verifyTicket } from '@fr33world/auth';
import {
  decodeGear,
  DEFAULT_APPEARANCE,
  encodeGear,
  HEADWEAR,
  NO_GEAR,
  TERMS_VERSION,
} from '@fr33world/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanName, SIGNUP_BONUS_CENTS } from './accounts.ts';
import { buildApp } from './app.ts';
import type { Db } from './db.ts';
import { audit } from './ledger.ts';
import { testDb } from './test-db.ts';

const SECRET = 'test-ticket-secret-long-enough-0123456789';
let db: Db;
let app: FastifyInstance;
/** What the stand-in Privy says about each user: guest (true), full (false), unreachable (null). */
const privyGuests = new Map<string, boolean | null>();

beforeAll(async () => {
  db = await testDb('app');
  app = buildApp({
    db,
    // "tok-<user>" stands in for a valid Privy token of <user>.
    verify: (t) => Promise.resolve(t.startsWith('tok-') ? `did:privy:${t.slice(4)}` : null),
    isGuest: (u) => Promise.resolve(privyGuests.has(u) ? (privyGuests.get(u) ?? null) : false),
    ticketSecret: SECRET,
    corsOrigins: ['https://game.example'],
    adminToken: 'admin-test-token',
    superAdmins: 'Ada Byron',
  });
});

afterAll(async () => {
  await app.close();
  await db.end();
});

const onboard = (user: string, birthDate = '1995-06-15', termsVersion = TERMS_VERSION) =>
  app.inject({
    method: 'POST',
    url: '/v1/onboarding',
    headers: { authorization: `Bearer tok-${user}` },
    payload: { birthDate, termsVersion },
  });

const LOOK = {
  ...DEFAULT_APPEARANCE,
  body: 'female',
  face: 2,
  outfit: 4,
  skin: 3,
  top: 1,
} as const;

const makeCharacter = (user: string, name: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/character',
    headers: { authorization: `Bearer tok-${user}` },
    payload: { name, age: 27, appearance: LOOK, ...extra },
  });

/** First login, onboarding as an adult, then a character named after the user. */
const join = async (user: string, name?: string) => {
  await session(user, name);
  await onboard(user);
  return makeCharacter(user, `${user[0]?.toUpperCase()}${user.slice(1)} Tester`);
};

const session = (user: string, name?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { authorization: `Bearer tok-${user}` },
    payload: name === undefined ? {} : { name },
  });

describe('sessions', () => {
  it('turn a first login into an account that must finish onboarding before playing', async () => {
    const first = await session('ada', 'Ada Lovelace');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      needs: ['age', 'terms', 'character'],
      ticket: null,
      balance: 0,
    });
    // Age and Terms done, a character still to make: no ticket, no bonus yet.
    const onboarded = await onboard('ada');
    expect(onboarded.json()).toMatchObject({ needs: ['character'], ticket: null, balance: 0 });
    const res = await makeCharacter('ada', 'ada byron');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      account: { id: string; name: string };
      character: { name: string; age: number; look: number };
      balance: number;
      ticket: string;
      needs: string[];
    }>();
    expect(body.needs).toEqual([]);
    expect(body.account.name).toBe('Ada Lovelace');
    expect(body.character).toMatchObject({ name: 'Ada Byron', age: 27 });
    expect(body.balance).toBe(SIGNUP_BONUS_CENTS);
    // In the city she is her character, and everyone sees her look.
    expect(verifyTicket(SECRET, body.ticket)).toMatchObject({
      account: body.account.id,
      name: 'Ada Byron',
      look: body.character.look,
    });
  });

  it('pay the bonus once, even for simultaneous first logins', async () => {
    await session('bo', 'Bo');
    const results = await Promise.all(Array.from({ length: 5 }, () => onboard('bo')));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const ids = new Set(results.map((r) => r.json<{ account: { id: string } }>().account.id));
    expect(ids.size).toBe(1);
    // Simultaneous character requests: one is made, the bonus is paid once.
    const made = await Promise.all(
      Array.from({ length: 4 }, () => makeCharacter('bo', 'Bo Diddley')),
    );
    expect(made.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const again = (await session('bo', 'Someone Else')).json<{
      balance: number;
      account: { name: string };
    }>();
    expect(again.balance).toBe(SIGNUP_BONUS_CENTS);
    // The name is the account's; a later login can't rename it.
    expect(again.account.name).toBe('Bo');
    const books = await audit(db);
    expect(books.total).toBe(0);
    expect(books.drifted).toBe(0);
  });

  it("know guests from Privy, and make them full accounts once they've linked one", async () => {
    const guestOf = async (who: string) =>
      (await session(who, 'Guest')).json<{ account: { guest: boolean } }>().account.guest;
    privyGuests.set('did:privy:gus', true);
    expect(await guestOf('gus')).toBe(true);
    // Privy unreachable on a later login: still a guest, not quietly upgraded.
    privyGuests.set('did:privy:gus', null);
    expect(await guestOf('gus')).toBe(true);
    // Linked an email: the same Privy user, no longer a guest.
    privyGuests.set('did:privy:gus', false);
    expect(await guestOf('gus')).toBe(false);
  });

  it('refuse missing or bad logins', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/session' })).statusCode).toBe(401);
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: 'Bearer forged' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('report the account and balance', async () => {
    await join('cy', 'Cy');
    const me = await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer tok-cy' } });
    expect(me.json()).toMatchObject({ account: { name: 'Cy' }, balance: SIGNUP_BONUS_CENTS });
    const nobody = await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer tok-zz' } });
    expect(nobody.statusCode).toBe(404);
  });
});

describe('the 18+ age gate', () => {
  it('blocks under-18s for good, with no money and no ticket', async () => {
    await session('kid', 'Kid');
    const res = await onboard('kid', '2015-01-01');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ blocked: 'under_18' });
    // Logging in again, or answering again with an older date, changes nothing.
    expect((await session('kid')).statusCode).toBe(403);
    expect((await onboard('kid', '1990-01-01')).statusCode).toBe(403);
    const wallet = await db.query<{ balance: number }>(
      `select l.balance from ledger_accounts l join accounts a on a.id = l.owner_id
       where a.privy_user_id = 'did:privy:kid'`,
    );
    expect(wallet.rows[0]?.balance).toBe(0);
  });

  it('takes the date of birth once', async () => {
    await join('dee', 'Dee');
    const change = await onboard('dee', '1980-01-01');
    expect(change.statusCode).toBe(409);
  });

  it('refuses impossible dates and an outdated Terms version', async () => {
    await session('eve', 'Eve');
    for (const bad of ['1995-02-30', '2999-01-01', '1800-01-01', 'yesterday']) {
      expect((await onboard('eve', bad)).statusCode).toBe(400);
    }
    expect((await onboard('eve', '1995-06-15', 'old-terms')).statusCode).toBe(400);
    // A refused answer stores nothing from that request (all or nothing).
    expect((await session('eve')).json()).toMatchObject({ needs: ['age', 'terms', 'character'] });
  });
});

describe('characters', () => {
  it('come after the age gate and the Terms, once per account', async () => {
    await session('fay');
    expect((await makeCharacter('fay', 'Fay Wray')).statusCode).toBe(409);
    await onboard('fay');
    expect((await makeCharacter('fay', 'Fay Wray')).statusCode).toBe(200);
    expect((await makeCharacter('fay', 'Fay Other')).statusCode).toBe(409);
  });

  it('wear their accessories, carried in the world ticket; refuse ones not on offer', async () => {
    await session('hal');
    await onboard('hal');
    const bad = { ...NO_GEAR, head: HEADWEAR.length };
    expect((await makeCharacter('hal', 'Hal Jordan', { gear: bad })).statusCode).toBe(400);
    const gear = { ...NO_GEAR, head: 1, eyes: 2, neck: 3, bag: 1, bagColour: 4 };
    const res = await makeCharacter('hal', 'Hal Jordan', { gear });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ character: { gear: number }; ticket: string }>();
    expect(decodeGear(body.character.gear)).toEqual(gear);
    expect(verifyTicket(SECRET, body.ticket)).toMatchObject({ gear: encodeGear(gear) });
  });

  it('need a free role-play name, an adult age and an appearance on offer', async () => {
    await session('gus');
    await onboard('gus');
    for (const name of ['Gus', 'G Unit', 'Gus 2pac', 'Gus Van Sant'])
      expect((await makeCharacter('gus', name)).statusCode).toBe(400);
    for (const age of [17, 81, 30.5, '30'])
      expect((await makeCharacter('gus', 'Gus Grissom', { age })).statusCode).toBe(400);
    for (const appearance of [{ ...LOOK, skin: 9 }, { ...LOOK, body: 'robot' }, null])
      expect((await makeCharacter('gus', 'Gus Grissom', { appearance })).statusCode).toBe(400);
    // Taken whatever the capitals.
    expect((await makeCharacter('gus', 'FAY WRAY')).statusCode).toBe(409);
    expect((await makeCharacter('gus', 'Gus Grissom')).statusCode).toBe(200);
  });

  it('can be checked for a free name while typing', async () => {
    const check = async (name: string) =>
      (
        await app.inject({ url: `/v1/character/name?name=${encodeURIComponent(name)}` })
      ).json<unknown>();
    expect(await check('gus grissom')).toEqual({ name: 'Gus Grissom', available: false });
    expect(await check('Nobody Yet')).toEqual({ name: 'Nobody Yet', available: true });
    expect(await check('x')).toHaveProperty('error');
  });
});

describe('names', () => {
  it('are trimmed, printable and at most 24 characters', () => {
    expect(cleanName('  Ada   Lovelace  ', 'x')).toBe('Ada Lovelace');
    expect(cleanName('a\u0000b​c', 'x')).toBe('abc');
    expect(cleanName('x'.repeat(40), 'x')).toHaveLength(24);
    expect(cleanName('', 'did:privy:abc123')).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
    expect(cleanName(42, 'did:privy:abc123')).toBe(cleanName('', 'did:privy:abc123'));
  });
});

describe('status', () => {
  it('reports the database', async () => {
    const res = await app.inject({ url: '/v1/status' });
    expect(res.json()).toMatchObject({ database: 'ok' });
  });
});

describe('error reports', () => {
  const report = (message: string, line: number) =>
    app.inject({
      method: 'POST',
      url: '/v1/errors',
      remoteAddress: `10.0.0.${line % 200}`,
      payload: {
        message,
        stack: `TypeError: ${message}\n    at frame (https://x/assets/index.js:1:${line})`,
        url: 'https://x/',
        build: 'abc123',
      },
    });

  it('group repeats of one bug and are readable with the admin token only', async () => {
    for (let i = 0; i < 3; i += 1)
      expect((await report("cannot read 'x' of undefined", 100 + i)).statusCode).toBe(204);
    await report('something else broke', 7);
    expect((await app.inject({ url: '/v1/admin/errors' })).statusCode).toBe(404);
    const list = await app.inject({
      url: '/v1/admin/errors',
      headers: { authorization: 'Bearer admin-test-token' },
    });
    const rows = list.json<{ message: string; count: number }[]>();
    expect(rows.find((r) => r.message.startsWith('cannot read'))?.count).toBe(3);
    expect(rows.find((r) => r.message === 'something else broke')?.count).toBe(1);
  });

  it('refuse empty reports and floods', async () => {
    const empty = await app.inject({ method: 'POST', url: '/v1/errors', payload: {} });
    expect(empty.statusCode).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 35; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/errors',
        remoteAddress: '10.9.9.9',
        payload: { message: `flood ${i}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBe(5);
  });
});

describe('CORS', () => {
  it('answers allowed origins only', async () => {
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/v1/session',
      headers: { origin: 'https://game.example' },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://game.example');
    const other = await app.inject({
      method: 'OPTIONS',
      url: '/v1/session',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('blocks and reports', () => {
  const as = (u: string) => ({ authorization: `Bearer tok-${u}` });

  it('block and unblock a character by name, never yourself or nobody', async () => {
    await join('ivy');
    await join('jon');
    const block = (name: string, blocked = true) =>
      app.inject({
        method: 'POST',
        url: '/v1/blocks',
        headers: as('ivy'),
        payload: { name, blocked },
      });
    expect((await block('jon tester')).json()).toEqual({ blocked: ['Jon Tester'] });
    expect((await app.inject({ url: '/v1/blocks', headers: as('ivy') })).json()).toEqual({
      blocked: ['Jon Tester'],
    });
    expect((await block('Ivy Tester')).statusCode).toBe(400);
    expect((await block('Nobody Here')).statusCode).toBe(404);
    expect((await block('Jon Tester', false)).json()).toEqual({ blocked: [] });
    expect((await app.inject({ url: '/v1/blocks' })).statusCode).toBe(401);
  });

  it('take reports with a known reason and show them to admins only', async () => {
    // Ivy and Jon from the test above (more logins would trip the per-address login limit).
    const send = (payload: object) =>
      app.inject({ method: 'POST', url: '/v1/reports', headers: as('ivy'), payload });
    expect((await send({ name: 'Jon Tester', reason: 'rude' })).statusCode).toBe(400);
    expect(
      (await send({ name: 'Jon Tester', reason: 'harassment', details: 'kept following me' }))
        .statusCode,
    ).toBe(204);
    const open = await app.inject({
      url: '/v1/admin/reports',
      headers: { authorization: 'Bearer admin-test-token' },
    });
    expect(open.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reporter: 'Ivy Tester',
          reported: 'Jon Tester',
          reason: 'harassment',
          details: 'kept following me',
        }),
      ]),
    );
    expect((await app.inject({ url: '/v1/admin/reports' })).statusCode).toBe(404);
  });
});

describe('staff and bans', () => {
  // A different address from the tests above (logins are limited per address).
  const fresh = (u: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: `Bearer tok-${u}` },
      remoteAddress: '10.9.9.9',
    });
  const world = { authorization: `Bearer ${internalKey(SECRET)}` };
  const ada = async () =>
    verifyTicket(SECRET, (await fresh('ada')).json<{ ticket: string }>().ticket);

  it('give the super admin every power in the ticket', async () => {
    expect((await ada())?.staff).toMatchObject({ role: 'super' });
  });

  it('keep where a character was for the world server, and only for it', async () => {
    const account = (await ada())?.account ?? '';
    const post = (url: string, payload: object, headers: Record<string, string> = world) =>
      app.inject({ method: 'POST', url, headers, payload });
    expect((await post('/v1/internal/place', { account }, {})).statusCode).toBe(404);
    expect((await post('/v1/internal/place', { account })).json()).toEqual({ place: null });
    const place = { x: 12.5, y: 0.2, z: -80, yaw: 1.5 };
    const saved = await post('/v1/internal/place/save', { places: [{ account, ...place }] });
    expect(saved.statusCode).toBe(200);
    expect((await post('/v1/internal/place', { account })).json()).toEqual({ place });
  });

  it('let only the world server make changes, and only the super admin make staff', async () => {
    const actor = (await ada())?.account ?? '';
    const jonTicket = verifyTicket(SECRET, (await fresh('jon')).json<{ ticket: string }>().ticket);
    const jon = jonTicket?.account ?? '';
    const setStaff = (by: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/v1/internal/staff',
        headers,
        payload: { actor: by, name: 'Jon Tester', permissions: ['kick', 'teleport', 'fly'] },
      });
    expect((await setStaff(actor, {})).statusCode).toBe(404);
    expect((await setStaff(jon, world)).statusCode).toBe(403);
    expect((await setStaff(actor, world)).json()).toEqual({
      name: 'Jon Tester',
      permissions: ['kick', 'teleport'],
    });
    const after = verifyTicket(SECRET, (await fresh('jon')).json<{ ticket: string }>().ticket);
    expect(after?.staff).toEqual({ role: 'admin', permissions: ['kick', 'teleport'] });
    // Jon may kick but not ban.
    const ban = (by: string, extra: object = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/internal/ban',
        headers: world,
        payload: { actor: by, name: 'Ivy Tester', hours: 2, reason: 'testing', ...extra },
      });
    expect((await ban(jon)).statusCode).toBe(403);
    expect((await ban(actor)).statusCode).toBe(200);
    const refused = await fresh('ivy');
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/banned until .*Reason: testing/);
    expect((await ban(actor, { lift: true })).statusCode).toBe(200);
    expect((await fresh('ivy')).statusCode).toBe(200);
    const log = await app.inject({
      url: '/v1/admin/audit',
      headers: { authorization: 'Bearer admin-test-token' },
    });
    expect(log.json<{ action: string }[]>().map((e) => e.action)).toEqual(
      expect.arrayContaining(['staff.set', 'ban', 'unban']),
    );
  });
});
