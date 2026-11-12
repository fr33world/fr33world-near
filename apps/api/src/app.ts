/**
 * The game API (decision D-34): accounts, the `$` economy and world tickets. Routes:
 *   GET  /health       liveness only (Render polls it; it must not wake the database)
 *   GET  /v1/status    database reachable, with its round-trip time
 *   POST /v1/session   Authorization: Bearer <Privy token>, body {name?}: account (created on
 *                      first login), balance, what onboarding still needs, and a world ticket
 *                      once it needs nothing
 *   POST /v1/onboarding  same auth, body {birthDate?: 'YYYY-MM-DD', termsVersion?}: the 18+
 *                      age gate (answered once) and Terms acceptance; answers like /v1/session
 *   POST /v1/character same auth, body {name, age, appearance, gear?}: makes the account's character
 *                      (once, after the age gate and the Terms); answers like /v1/session
 *   GET  /v1/character/name?name=  whether a character name is free (and how it's written)
 *   GET  /v1/me        Authorization: Bearer <Privy token>: account and balance
 *   GET  /v1/bank?before=  same auth: balance, frozen, and a page of history (newest first)
 *   POST /v1/bank/pay  same auth, body {to, cents, note?, key}: pays another character
 *   GET  /v1/progress  same auth: level, XP and the latest rewards
 *   GET  /v1/messages, /v1/messages/thread?name=, POST /v1/messages  same auth: private messages
 *   GET  /v1/daily, POST /v1/daily/claim  same auth: login streak, spin, tasks, level bonuses
 *   GET  /v1/garage    same auth: the cars this account owns (a starter car the first time)
 *   POST /v1/internal/garage  the world server: a player's cars, when they call one
 *   POST /v1/dealer/buy  same auth, body {model, key}: buys a car (shared CARS_FOR_SALE)
 *   POST /v1/internal/fare  the world server, body {account, cents, key, kind, to?}: charges a
 *                      fare (a taxi ride, fuel, a repair)
 *   POST /v1/internal/arms{,/buy,/rounds}  the world server: a player's weapons and rounds,
 *                      buying at the gun store or black market, rounds fired
 *   GET  /v1/market    open car listings; POST /v1/market/{list,withdraw,buy} (Privy auth, full
 *                      accounts): sell your car for $, take it down, buy one (market.ts)
 *   GET  /v1/inbox     Privy auth: notices waiting (POST /v1/inbox/read marks them read)
 *   GET  /v1/factions  Privy auth: the player's faction (rank, roster, applicants for
 *                      recruiters) or application; POST /v1/factions/{apply,quiz,leave}
 *   POST /v1/internal/faction{,/decide,/rank,/dismiss,/boss,/fine,/id}  the world server: a
 *                      player's membership, recruiters' decisions, ranks, bosses, fines, IDs
 *   POST /v1/internal/place{,/save}  the world server: where a character was last
 *   POST /v1/internal/kills  the world server: someone went down to someone (the kill log)
 *   GET  /v1/admin/kills?name=  Authorization: Bearer <ADMIN_TOKEN>: the latest kills
 *   POST /v1/internal/garage/condition  the world server, body {account, car, fuel, health}:
 *                      a car's fuel and condition as it goes back to the garage
 *   POST /v1/tutorial  same auth, body {step}: the tutorial's progress (forward only); 'done'
 *                      pays its reward once
 *   POST /v1/internal/reward  the world server: money and XP for validated activity
 *   POST /v1/internal/jobs/{save,load}  the world server: a player's job shift in progress
 *   GET  /v1/blocks    same auth: the character names this account has blocked
 *   POST /v1/blocks    same auth, body {name, blocked}: blocks or unblocks a character
 *   POST /v1/reports   same auth, body {name, reason, details?}: reports a character
 *   GET  /v1/admin/reports  Authorization: Bearer <ADMIN_TOKEN>: reports not yet reviewed
 *   GET  /v1/admin/audit    same: the latest staff actions
 *   GET  /v1/admin/economy  same: the books, whether the economy is paused, recent alerts and
 *                      open anomaly flags
 *   POST /v1/admin/flags/:id  same, body {note?, freeze?, thaw?}: reviews a flag
 *   POST /v1/admin/economy/resume  same: resumes a paused economy once the books are right
 *   POST /v1/internal/{staff,staff/list,ban,audit,money,money/reverse,money/freeze,
 *                      money/balance}  the world server only (key from the ticket secret), on
 *                      staff's chat commands
 *   POST /v1/errors    a game client's error report (no login; rate-limited, grouped)
 *   GET  /v1/admin/errors  Authorization: Bearer <ADMIN_TOKEN>: the latest grouped errors
 */
import { internalKey, signTicket, TICKET_TTL_S } from '@fr33world/auth';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  checkName,
  completeOnboarding,
  createCharacter,
  OnboardingError,
  openSession,
  type Session,
} from './accounts.ts';
import type { Db } from './db.ts';
import { readReport, recentErrors, recordError } from './errors.ts';
import { type EconomyDeps, finishJob, settleJobs, tick } from './business.ts';
import {
  buyWithDollars,
  economyView,
  finishSale,
  finishSend,
  linkWallet,
  shelf,
  startSale,
  startSend,
  takeDelivery,
  usdcWallet,
  type UsdcDeps,
  claimTestUsdc,
  testUsdcStatus,
} from './usdc.ts';
import { openFlags, reviewFlag } from './anomalies.ts';
import { BankError, pay, statement } from './bank.ts';
import { correct, freeze, lookUp, reverse } from './corrections.ts';
import { claimDaily, dailyStatus } from './daily.ts';
import { conversations, sendMessage, thread } from './messages.ts';
import { progress, reward, RewardError } from './rewards.ts';
import { advanceTutorial, TutorialError } from './tutorial.ts';
import {
  armsOf,
  buyArms,
  type GangRank,
  logKill,
  recentKills,
  spendRounds,
  buyCare,
  useCare,
} from './armory.ts';
import { chargeFare } from './fares.ts';
import { inbox } from './inbox.ts';
import { buyListed, listCar, listings, withdraw } from './market.ts';
import {
  appointBoss,
  applyTo,
  decide,
  dismiss,
  factionStatus,
  fine,
  gangRank,
  idCard,
  leave,
  memberOf,
  setRank,
  takeQuiz,
  deskStatus,
  scheduleInterview,
} from './factions.ts';
import { createGang, decideMember, gangStatus, joinGang, leaveGang } from './gangs.ts';
import { buyCar, garageOf, saveCondition } from './garage.ts';
import { placeOf, savePlaces } from './places.ts';
import { audit as checkBooks } from './ledger.ts';
import { economyState, problems, recentAlerts, resumeEconomy } from './monitor.ts';
import { blockedNames, openReports, report, SafetyError, setBlocked } from './safety.ts';
import {
  audit,
  banOf,
  listStaff,
  recentAudit,
  setBan,
  setStaff,
  StaffError,
  staffOf,
  superAdmins,
} from './staff.ts';

export interface AppDeps {
  db: Db;
  /** Privy token → Privy user id, or null. */
  verify: (token: string) => Promise<string | null>;
  /** Whether a Privy user is a guest, or null when Privy can't say (logins only). */
  isGuest: (privyUser: string) => Promise<boolean | null>;
  ticketSecret: string;
  /** Origins allowed to call the API from a browser. */
  corsOrigins: string[];
  /** Bearer token for /v1/admin routes; unset disables them. */
  adminToken?: string;
  /** Super admins' character names (default: the SUPER_ADMINS setting). */
  superAdmins?: string;
  logger?: boolean;
  /** A player's gang rank (factions); none until Phase 9 wires it. */
  gangRank?: GangRank;
  /** NEAR (Phase 17): absent when no operator key is set, and USDC routes then say so. */
  economy?: EconomyDeps;
  usdc?: UsdcDeps;
}

/** Logins per address per minute (each one verifies a token and touches the database). */
const SESSION_LIMIT = 20;

export function buildApp(deps: AppDeps): FastifyInstance {
  const supers = superAdmins(deps.superAdmins);
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024, trustProxy: true });
  const origins = new Set(deps.corsOrigins);

  // CORS by hand: an allowlist, no credentials (the Privy token travels in a header).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      reply.header('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  /** Fixed-window limiter per address: `max` requests a minute per `bucket`. */
  const hits = new Map<string, { n: number; since: number }>();
  const limited = (ip: string, bucket = 'session', max = SESSION_LIMIT) => {
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.since > 60_000) {
      hits.set(key, { n: 1, since: now });
      if (hits.size > 50_000) hits.clear();
      return false;
    }
    h.n += 1;
    return h.n > max;
  };

  const user = async (req: FastifyRequest) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return token ? deps.verify(token) : null;
  };

  app.get('/health', () => 'ok');

  app.get('/v1/status', async (_req, reply) => {
    const started = performance.now();
    try {
      await deps.db.query('select 1');
      return { database: 'ok', dbMs: Math.round(performance.now() - started) };
    } catch {
      return reply.code(503).send({ database: 'unreachable' });
    }
  });

  app.post('/v1/session', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'Too many logins. Wait a minute.' });
    const privyUser = await user(req);
    if (!privyUser) return reply.code(401).send({ error: 'Please log in again.' });
    const body = (req.body ?? {}) as { name?: unknown };
    const guest = await deps.isGuest(privyUser);
    return answer(reply, await openSession(deps.db, privyUser, body.name, guest));
  });

  app.post('/v1/onboarding', async (req, reply) => {
    const privyUser = await user(req);
    if (!privyUser) return reply.code(401).send({ error: 'Please log in again.' });
    const body = (req.body ?? {}) as { birthDate?: unknown; termsVersion?: unknown };
    try {
      return answer(reply, await completeOnboarding(deps.db, privyUser, body));
    } catch (e) {
      if (e instanceof OnboardingError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  app.post('/v1/character', async (req, reply) => {
    const privyUser = await user(req);
    if (!privyUser) return reply.code(401).send({ error: 'Please log in again.' });
    const body = (req.body ?? {}) as {
      name?: unknown;
      age?: unknown;
      appearance?: unknown;
      gear?: unknown;
    };
    try {
      return answer(reply, await createCharacter(deps.db, privyUser, body));
    } catch (e) {
      if (e instanceof OnboardingError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  app.get('/v1/character/name', async (req, reply) => {
    if (limited(req.ip, 'names', 120))
      return reply.code(429).send({ error: 'Slow down a little.' });
    return checkName(deps.db, (req.query as { name?: unknown }).name);
  });

  /** Session reply: a ticket only once nothing is outstanding; 403 for a blocked account. */
  const answer = async (reply: FastifyReply, s: Session) => {
    if (s.blocked) {
      return reply.code(403).send({
        error: 'fr33world is for players aged 18 and over.',
        blocked: s.blocked,
      });
    }
    const ban = await banOf(deps.db, s.account.id);
    if (ban) {
      return reply.code(403).send({
        error: `This account is banned${ban.until ? ` until ${ban.until}` : ''}.${ban.reason ? ` Reason: ${ban.reason}` : ''}`,
        blocked: 'banned',
      });
    }
    const staff = s.character
      ? await staffOf(deps.db, s.account.id, s.character.name, supers)
      : null;
    const ticket =
      s.needs.length === 0
        ? signTicket(deps.ticketSecret, {
            account: s.account.id,
            // In the city everyone goes by their character's name.
            name: s.character?.name ?? s.account.name,
            guest: s.account.guest,
            ...(s.character
              ? { look: s.character.look, gear: s.character.gear, xp: s.character.xp }
              : {}),
            ...(staff ? { staff } : {}),
          })
        : null;
    return {
      account: s.account,
      character: s.character,
      balance: s.balance,
      needs: s.needs,
      ticket,
      ticketTtl: TICKET_TTL_S,
    };
  };

  app.post('/v1/errors', async (req, reply) => {
    if (limited(req.ip, 'errors', 30)) return reply.code(429).send();
    const report = readReport(req.body, req.headers['user-agent'] ?? '');
    if (!report) return reply.code(400).send({ error: 'no message' });
    await recordError(deps.db, report);
    return reply.code(204).send();
  });

  app.get('/v1/admin/errors', async (req, reply) => {
    const token = deps.adminToken;
    const given = req.headers.authorization ?? '';
    if (!token || given !== `Bearer ${token}`) return reply.code(404).send();
    return recentErrors(deps.db);
  });

  const safety = async (
    req: FastifyRequest,
    reply: FastifyReply,
    run: (privyUser: string) => Promise<unknown>,
  ) => {
    const privyUser = await user(req);
    if (!privyUser) return reply.code(401).send({ error: 'Please log in again.' });
    try {
      return await run(privyUser);
    } catch (e) {
      if (e instanceof SafetyError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  };

  // The bank (bank.ts): statement and payments, from the in-game phone.
  const bank = async (
    req: FastifyRequest,
    reply: FastifyReply,
    run: (privyUser: string) => Promise<unknown>,
  ) => {
    const privyUser = await user(req);
    if (!privyUser) return reply.code(401).send({ error: 'Please log in again.' });
    try {
      return await run(privyUser);
    } catch (e) {
      if (e instanceof BankError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  };
  app.get<{ Querystring: { before?: string } }>('/v1/bank', (req, reply) =>
    bank(req, reply, (u) =>
      statement(deps.db, u, req.query.before ? Number(req.query.before) : undefined),
    ),
  );
  app.post('/v1/bank/pay', (req, reply) => {
    if (limited(req.ip, 'pay', 20)) return reply.code(429).send({ error: 'Slow down.' });
    return bank(req, reply, (u) => pay(deps.db, u, req.body ?? {}));
  });

  app.get('/v1/blocks', (req, reply) =>
    safety(req, reply, async (u) => ({ blocked: await blockedNames(deps.db, u) })),
  );

  app.post('/v1/blocks', (req, reply) =>
    safety(req, reply, async (u) => {
      const body = (req.body ?? {}) as { name?: unknown; blocked?: unknown };
      return { blocked: await setBlocked(deps.db, u, body.name, body.blocked !== false) };
    }),
  );

  app.post('/v1/reports', (req, reply) => {
    if (limited(req.ip, 'reports', 10)) return reply.code(429).send({ error: 'Slow down.' });
    return safety(req, reply, async (u) => {
      await report(deps.db, u, req.body ?? {});
      return reply.code(204).send();
    });
  });

  // ---- the world server's own calls (staff commands): the key derived from the ticket secret
  const isAdmin = (req: FastifyRequest) =>
    !!deps.adminToken && (req.headers.authorization ?? '') === `Bearer ${deps.adminToken}`;
  const world = internalKey(deps.ticketSecret);
  const fromWorld = (req: FastifyRequest) =>
    (req.headers.authorization ?? '') === `Bearer ${world}`;
  const internal = async (
    req: FastifyRequest,
    reply: FastifyReply,
    run: (body: Record<string, unknown>, actor: string) => Promise<unknown>,
  ) => {
    if (!fromWorld(req)) return reply.code(404).send();
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.actor !== 'string') return reply.code(400).send({ error: 'actor?' });
    try {
      return await run(body, body.actor);
    } catch (e) {
      if (e instanceof StaffError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  };
  app.post('/v1/internal/staff', (req, reply) =>
    internal(req, reply, (body, actor) => setStaff(deps.db, actor, body, supers)),
  );
  app.post('/v1/internal/staff/list', (req, reply) =>
    internal(req, reply, async () => ({ staff: await listStaff(deps.db) })),
  );
  app.post('/v1/internal/ban', (req, reply) =>
    internal(req, reply, (body, actor) => setBan(deps.db, actor, body, supers)),
  );
  app.post('/v1/internal/money', (req, reply) =>
    internal(req, reply, (body, actor) => correct(deps.db, actor, body, supers)),
  );
  app.post('/v1/internal/money/reverse', (req, reply) =>
    internal(req, reply, (body, actor) => reverse(deps.db, actor, body, supers)),
  );
  app.post('/v1/internal/money/freeze', (req, reply) =>
    internal(req, reply, (body, actor) => freeze(deps.db, actor, body, supers)),
  );
  app.post('/v1/internal/money/balance', (req, reply) =>
    internal(req, reply, (body, actor) => lookUp(deps.db, actor, body, supers)),
  );
  app.post('/v1/internal/reward', async (req, reply) => {
    if (!fromWorld(req)) return reply.code(404).send();
    try {
      return await reward(deps.db, req.body ?? {});
    } catch (e) {
      if (e instanceof RewardError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
  // A job shift in progress (apps/world jobs/): saved at each step, loaded on joining.
  app.post('/v1/internal/jobs/save', async (req, reply) => {
    if (!fromWorld(req)) return reply.code(404).send();
    const body = (req.body ?? {}) as {
      account?: unknown;
      saved?: { job?: unknown; shift?: unknown; state?: unknown } | null;
    };
    if (typeof body.account !== 'string') return reply.code(400).send({ error: 'account?' });
    const s = body.saved;
    if (!s) {
      await deps.db.query('delete from job_shifts where account_id = $1', [body.account]);
      return { saved: null };
    }
    if (typeof s.job !== 'string' || typeof s.shift !== 'string')
      return reply.code(400).send({ error: 'job?' });
    await deps.db.query(
      `insert into job_shifts (account_id, job, shift, state) values ($1, $2, $3, $4)
       on conflict (account_id) do update
         set job = excluded.job, shift = excluded.shift, state = excluded.state, updated_at = now()`,
      [body.account, s.job, s.shift, JSON.stringify(s.state ?? null)],
    );
    return { saved: true };
  });
  app.post('/v1/internal/jobs/load', async (req, reply) => {
    if (!fromWorld(req)) return reply.code(404).send();
    const account = (req.body as { account?: unknown } | undefined)?.account;
    if (typeof account !== 'string') return reply.code(400).send({ error: 'account?' });
    // A shift left more than a day ago is over.
    const r = await deps.db.query<{ job: string; shift: string; state: unknown }>(
      `select job, shift, state from job_shifts
       where account_id = $1 and updated_at > now() - interval '1 day'`,
      [account],
    );
    return { saved: r.rows[0] ?? null };
  });

  app.post('/v1/tutorial', (req, reply) => {
    if (limited(req.ip, 'tutorial', 40)) return reply.code(429).send({ error: 'Slow down.' });
    return bank(req, reply, async (u) => {
      try {
        return await advanceTutorial(deps.db, u, req.body ?? {});
      } catch (e) {
        if (e instanceof TutorialError) throw new BankError(e.message, e.status);
        throw e;
      }
    });
  });

  // The garage: the world server asks for a player's cars when they call one at a car park.
  app.post('/v1/internal/garage', async (req, reply) => {
    if (!fromWorld(req)) return reply.code(404).send();
    const account = (req.body as { account?: unknown } | undefined)?.account;
    if (typeof account !== 'string') return reply.code(400).send({ error: 'account?' });
    return { cars: await garageOf(deps.db, account) };
  });
  app.get('/v1/garage', (req, reply) =>
    bank(req, reply, async (u) => {
      const r = await deps.db.query<{ id: string }>(
        'select id from accounts where privy_user_id = $1',
        [u],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new BankError('Please log in again.', 401);
      return { cars: await garageOf(deps.db, id) };
    }),
  );
  // The armoury (armory.ts). Gang ranks come with factions (Phase 9).
  const worldPost = (path: string, run: (body: Record<string, unknown>) => Promise<unknown>) =>
    app.post(path, async (req, reply) => {
      if (!fromWorld(req)) return reply.code(404).send();
      try {
        return await run((req.body ?? {}) as Record<string, unknown>);
      } catch (e) {
        if (e instanceof BankError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    });
  worldPost('/v1/internal/arms', async (b) => {
    if (typeof b.account !== 'string') throw new BankError('account?');
    return { arms: await armsOf(deps.db, b.account) };
  });
  worldPost('/v1/internal/place', async (b) => ({ place: await placeOf(deps.db, b.account) }));
  worldPost('/v1/internal/place/save', async (b) => {
    await savePlaces(deps.db, b);
    return { ok: true };
  });
  worldPost('/v1/internal/arms/buy', (b) => buyArms(deps.db, deps.gangRank ?? gangRank, b));
  worldPost('/v1/internal/care/buy', (b) => buyCare(deps.db, b));
  worldPost('/v1/internal/care/use', (b) => useCare(deps.db, b));

  // The economy (business.ts, usdc.ts). The trigger is public because it can only do what the
  // rules and wallet limits allow, and at most once per gap: the schedule needs no secret.
  worldPost('/v1/internal/goods/buy', (b) => buyWithDollars(deps.db, b));
  worldPost('/v1/internal/haul/finish', async (b) => {
    await finishJob(deps.db, { account: String(b.account) });
    if (deps.economy) await settleJobs(deps.economy);
    return { ok: true };
  });
  app.get('/v1/economy', () => {
    const chain = deps.economy?.chain;
    return economyView(deps.db, chain ? (account) => chain.summary(account) : undefined);
  });
  app.get('/v1/market/shelf', () => shelf(deps.db));
  app.post('/v1/economy/tick', async (req, reply) => {
    if (limited(req.ip, 'tick', 6)) return reply.code(429).send();
    if (!deps.economy) return reply.code(503).send({ error: 'The economy isn’t on here.' });
    return tick(deps.economy);
  });
  const withUsdc = (
    req: FastifyRequest,
    reply: FastifyReply,
    run: (d: UsdcDeps, privyUser: string) => Promise<unknown>,
  ) => {
    const d = deps.usdc;
    if (!d) return reply.code(503).send({ error: 'USDC isn’t on here.' });
    if (limited(req.ip, 'usdc', 60)) return reply.code(429).send({ error: 'Slow down.' });
    return bank(req, reply, (u) => run(d, u));
  };
  const usdcBody = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  app.post('/v1/usdc/job', (req, reply) =>
    withUsdc(req, reply, async (d, u) => {
      await takeDelivery(d, u, usdcBody(req));
      if (deps.economy) await settleJobs(deps.economy);
      return { ok: true };
    }),
  );
  app.get('/v1/usdc', (req, reply) => withUsdc(req, reply, (d, u) => usdcWallet(d, u)));
  app.post('/v1/usdc/link', (req, reply) => withUsdc(req, reply, (d, u) => linkWallet(d, u)));
  // Test USDC from the public testnet faucet, within shared TEST_USDC's limits (usdc.ts).
  app.get('/v1/usdc/faucet', (req, reply) => withUsdc(req, reply, (d, u) => testUsdcStatus(d, u)));
  app.post('/v1/usdc/faucet', (req, reply) =>
    limited(req.ip, 'faucet', 3)
      ? reply.code(429).send({ error: 'Slow down.' })
      : withUsdc(req, reply, (d, u) => claimTestUsdc(d, u)),
  );
  app.post('/v1/usdc/sale', (req, reply) =>
    withUsdc(req, reply, (d, u) => startSale(d, u, usdcBody(req))),
  );
  app.post('/v1/usdc/sale/finish', (req, reply) =>
    withUsdc(req, reply, (d, u) => finishSale(d, u, usdcBody(req))),
  );
  app.post('/v1/usdc/send', (req, reply) =>
    withUsdc(req, reply, (d, u) => startSend(d, u, usdcBody(req))),
  );
  app.post('/v1/usdc/send/finish', (req, reply) =>
    withUsdc(req, reply, (d, u) => finishSend(d, u, usdcBody(req))),
  );
  // Factions (factions.ts): the phone with a Privy login, the world server for the rest.
  app.get('/v1/factions', (req, reply) => bank(req, reply, (u) => factionStatus(deps.db, u)));
  app.get('/v1/factions/desk', (req, reply) => bank(req, reply, (u) => deskStatus(deps.db, u)));
  app.get('/v1/gangs', (req, reply) => bank(req, reply, (u) => gangStatus(deps.db, u)));
  // Joining, trading and the inbox are limited per address like payments.
  const slow = (req: FastifyRequest, reply: FastifyReply, bucket: string, perMinute: number) =>
    limited(req.ip, bucket, perMinute) ? reply.code(429).send({ error: 'Slow down.' }) : null;
  app.post(
    '/v1/gangs/create',
    (req, reply) =>
      slow(req, reply, 'factions', 10) ??
      bank(req, reply, (u) => createGang(deps.db, u, req.body ?? {})),
  );
  app.post(
    '/v1/gangs/join',
    (req, reply) =>
      slow(req, reply, 'factions', 10) ??
      bank(req, reply, (u) => joinGang(deps.db, u, req.body ?? {})),
  );
  app.post(
    '/v1/gangs/leave',
    (req, reply) =>
      slow(req, reply, 'factions', 10) ?? bank(req, reply, (u) => leaveGang(deps.db, u)),
  );
  app.post(
    '/v1/gangs/decide',
    (req, reply) =>
      slow(req, reply, 'factions', 20) ??
      bank(req, reply, (u) => decideMember(deps.db, u, req.body ?? {})),
  );
  app.post(
    '/v1/factions/apply',
    (req, reply) =>
      slow(req, reply, 'factions', 10) ??
      bank(req, reply, (u) => applyTo(deps.db, u, req.body ?? {})),
  );
  app.post(
    '/v1/factions/quiz',
    (req, reply) =>
      slow(req, reply, 'factions', 10) ??
      bank(req, reply, (u) => takeQuiz(deps.db, u, req.body ?? {})),
  );
  app.post(
    '/v1/factions/leave',
    (req, reply) => slow(req, reply, 'factions', 10) ?? bank(req, reply, (u) => leave(deps.db, u)),
  );
  // The car market (market.ts).
  app.get(
    '/v1/market',
    async (req, reply) =>
      slow(req, reply, 'market-read', 60) ?? { listings: await listings(deps.db) },
  );
  app.post(
    '/v1/market/list',
    (req, reply) =>
      slow(req, reply, 'market', 20) ??
      bank(req, reply, (u) => listCar(deps.db, u, req.body ?? {})),
  );
  app.post(
    '/v1/market/withdraw',
    (req, reply) =>
      slow(req, reply, 'market', 20) ??
      bank(req, reply, (u) => withdraw(deps.db, u, req.body ?? {})),
  );
  app.post('/v1/market/buy', (req, reply) => {
    if (limited(req.ip, 'market', 20)) return reply.code(429).send({ error: 'Slow down.' });
    return bank(req, reply, (u) => buyListed(deps.db, u, req.body ?? {}));
  });
  // The inbox (inbox.ts): GET reads, POST marks everything read.
  app.get('/v1/inbox', (req, reply) => bank(req, reply, (u) => inbox(deps.db, u)));
  app.post(
    '/v1/inbox/read',
    (req, reply) =>
      slow(req, reply, 'inbox', 60) ?? bank(req, reply, (u) => inbox(deps.db, u, true)),
  );
  worldPost('/v1/internal/faction', async (b) => {
    if (typeof b.account !== 'string') throw new BankError('account?');
    return { membership: await memberOf(deps.db, b.account) };
  });
  worldPost('/v1/internal/faction/decide', (b) => decide(deps.db, b));
  worldPost('/v1/internal/faction/interview', (b) => scheduleInterview(deps.db, b));
  worldPost('/v1/internal/faction/rank', (b) => setRank(deps.db, b));
  worldPost('/v1/internal/faction/dismiss', (b) => dismiss(deps.db, b));
  worldPost('/v1/internal/faction/boss', (b) => appointBoss(deps.db, b));
  worldPost('/v1/internal/faction/fine', (b) => fine(deps.db, b));
  worldPost('/v1/internal/faction/id', (b) => idCard(deps.db, b));
  worldPost('/v1/internal/arms/rounds', async (b) => ({ arms: await spendRounds(deps.db, b) }));
  worldPost('/v1/internal/kills', async (b) => {
    await logKill(deps.db, b);
    return { logged: true };
  });
  app.get<{ Querystring: { name?: string } }>('/v1/admin/kills', async (req, reply) => {
    const token = deps.adminToken;
    if (!token || (req.headers.authorization ?? '') !== `Bearer ${token}`)
      return reply.code(404).send();
    return { kills: await recentKills(deps.db, req.query.name) };
  });

  app.post('/v1/internal/garage/condition', async (req, reply) => {
    if (!fromWorld(req)) return reply.code(404).send();
    try {
      return { saved: await saveCondition(deps.db, req.body ?? {}) };
    } catch (e) {
      if (e instanceof BankError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
  app.post('/v1/internal/fare', async (req, reply) => {
    if (!fromWorld(req)) return reply.code(404).send();
    try {
      return await chargeFare(deps.db, req.body ?? {});
    } catch (e) {
      if (e instanceof BankError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
  app.post('/v1/dealer/buy', (req, reply) => {
    if (limited(req.ip, 'dealer', 20)) return reply.code(429).send({ error: 'Slow down.' });
    return bank(req, reply, (u) => buyCar(deps.db, u, req.body ?? {}));
  });

  app.get('/v1/messages', (req, reply) => bank(req, reply, (u) => conversations(deps.db, u)));
  app.get('/v1/messages/thread', (req, reply) =>
    bank(req, reply, (u) => thread(deps.db, u, (req.query as { name?: unknown }).name)),
  );
  app.post('/v1/messages', (req, reply) => {
    if (limited(req.ip, 'messages', 30)) return reply.code(429).send({ error: 'Slow down.' });
    return bank(req, reply, (u) => sendMessage(deps.db, u, req.body ?? {}));
  });
  app.get('/v1/daily', (req, reply) => bank(req, reply, (u) => dailyStatus(deps.db, u)));
  app.post('/v1/daily/claim', (req, reply) =>
    bank(req, reply, (u) => claimDaily(deps.db, u, req.body ?? {})),
  );
  app.get('/v1/progress', (req, reply) =>
    bank(req, reply, async (u) => {
      try {
        return await progress(deps.db, u);
      } catch (e) {
        if (e instanceof RewardError) throw new BankError(e.message, e.status);
        throw e;
      }
    }),
  );
  app.post('/v1/internal/audit', (req, reply) =>
    internal(req, reply, async (body, actor) => {
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      await audit(deps.db, actor, str(body.action), str(body.target), str(body.details));
      return reply.code(204).send();
    }),
  );

  // The economy (monitor.ts): the books, whether it's paused and why, and recent alerts;
  // resuming once the cause is fixed (refused while the books are still wrong).
  app.get('/v1/admin/economy', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(404).send();
    const [books, state, alerts, flags] = await Promise.all([
      checkBooks(deps.db),
      economyState(deps.db),
      recentAlerts(deps.db, 20),
      openFlags(deps.db),
    ]);
    return { books, problems: problems(books), ...state, alerts, flags };
  });
  app.post<{ Params: { id: string } }>('/v1/admin/flags/:id', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(404).send();
    const body = (req.body ?? {}) as { note?: unknown; freeze?: unknown; thaw?: unknown };
    const done = await reviewFlag(deps.db, Number(req.params.id), 'admin token', {
      note: typeof body.note === 'string' ? body.note : undefined,
      freeze: body.freeze === true,
      thaw: body.thaw === true,
    });
    return done ? { reviewed: true } : reply.code(404).send({ error: 'No such open flag' });
  });
  app.post('/v1/admin/economy/resume', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(404).send();
    const found = problems(await checkBooks(deps.db));
    if (found.length > 0)
      return reply.code(409).send({ error: `The books are still wrong: ${found.join('; ')}` });
    await resumeEconomy(deps.db, 'admin token');
    return economyState(deps.db);
  });

  app.get('/v1/admin/audit', async (req, reply) => {
    const token = deps.adminToken;
    if (!token || (req.headers.authorization ?? '') !== `Bearer ${token}`)
      return reply.code(404).send();
    return recentAudit(deps.db);
  });

  app.get('/v1/admin/reports', async (req, reply) => {
    const token = deps.adminToken;
    const given = req.headers.authorization ?? '';
    if (!token || given !== `Bearer ${token}`) return reply.code(404).send();
    return openReports(deps.db);
  });

  app.get('/v1/me', async (req, reply) => {
    const privyUser = await user(req);
    if (!privyUser) return reply.code(401).send({ error: 'Please log in again.' });
    const r = await deps.db.query<{
      id: string;
      display_name: string;
      is_guest: boolean;
      balance: number;
    }>(
      `select a.id, a.display_name, a.is_guest, coalesce(l.balance, 0) as balance
       from accounts a left join ledger_accounts l on l.owner_id = a.id and l.kind = 'player'
       where a.privy_user_id = $1`,
      [privyUser],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: 'No account yet.' });
    return {
      account: { id: row.id, name: row.display_name, guest: row.is_guest },
      balance: row.balance,
    };
  });

  return app;
}
