/**
 * Factions behind the phone and the world server (Phase 9, D-26; shared FACTIONS): status,
 * applying, the training quiz, recruiters' decisions after the interview, ranks, dismissals, the
 * super admin appointing bosses, police fines and ID checks. Every action is audited.
 */
import {
  FACTION_IDS,
  type FactionId,
  FACTIONS,
  FINE,
  hasPower,
  isFactionId,
  type Membership,
  QUIZ,
  quizFor,
  rankOf,
} from '@fr33world/shared';
import { BankError } from './bank.ts';
import { notify } from './inbox.ts';
import { type Db, inTx, type Tx } from './db.ts';
import { spend } from './economy.ts';
import { superAdmins } from './staff.ts';
import { AccountFrozen, EconomyPaused, InsufficientFunds, LedgerError } from './ledger.ts';

export class FactionError extends BankError {}

/** The owner's character (owner, 2026-10-31): boss over every faction's applications. */
const OVERALL_BOSS = 'david horjet';

interface Person {
  id: string;
  name: string;
}

async function byPrivy(db: Db, privyUser: string): Promise<Person> {
  const r = await db.query<Person>(
    `select a.id, c.name from accounts a join characters c on c.account_id = a.id
     where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me) throw new FactionError('Make your character first.', 403);
  return me;
}

async function byName(db: Db | Tx, name: unknown): Promise<Person> {
  if (typeof name !== 'string' || !name.trim()) throw new FactionError('Who?');
  const r = await db.query<Person>(
    'select account_id as id, name from characters where lower(name) = lower($1)',
    [name.trim()],
  );
  const them = r.rows[0];
  if (!them) throw new FactionError(`Nobody in the city is called ${name.trim()}.`, 404);
  return them;
}

async function byAccount(db: Db | Tx, account: unknown): Promise<Person> {
  if (typeof account !== 'string') throw new FactionError('account?');
  const r = await db.query<Person>(
    'select account_id as id, name from characters where account_id = $1',
    [account],
  );
  const them = r.rows[0];
  if (!them) throw new FactionError('No character.', 404);
  return them;
}

export async function memberOf(db: Db | Tx, account: string): Promise<Membership | null> {
  const r = await db.query<{ faction: string; rank: number }>(
    'select faction, rank from memberships where account_id = $1',
    [account],
  );
  const m = r.rows[0];
  return m && isFactionId(m.faction) ? { faction: m.faction, rank: m.rank } : null;
}

/** For the black market (shared ARMORY): the gang rank, 0 outside a gang. */
export async function gangRank(db: Db | Tx, account: string): Promise<number> {
  const m = await memberOf(db, account);
  return m && FACTIONS[m.faction].kind === 'gang' ? m.rank : 0;
}

async function audit(
  db: Db | Tx,
  faction: string,
  actor: string,
  action: string,
  target = '',
  details = '',
) {
  await db.query(
    'insert into faction_audit (faction, actor, action, target, details) values ($1, $2, $3, $4, $5)',
    [faction, actor, action, target, details.slice(0, 300)],
  );
}

interface Application {
  faction: FactionId;
  stage: 'training' | 'interview';
  /** When the quiz may be tried again (ISO), after a fail. */
  retryAt: string | null;
  /** Which questions they're asked (shared quizFor). */
  quizSeed: number;
  /** When a boss has set their interview for (ISO). */
  interviewAt: string | null;
}

async function openApplication(db: Db | Tx, account: string): Promise<Application | null> {
  const r = await db.query<{
    id: string;
    faction: string;
    stage: string;
    quiz_failed_at: Date | null;
    quiz_seed: number;
    interview_at: Date | null;
  }>(
    `select id, faction, stage, quiz_failed_at, quiz_seed, interview_at from applications
     where account_id = $1 and stage in ('training', 'interview')`,
    [account],
  );
  const a = r.rows[0];
  if (!a || !isFactionId(a.faction)) return null;
  const retry = a.quiz_failed_at ? new Date(a.quiz_failed_at).getTime() + QUIZ.retryMs : 0;
  return {
    faction: a.faction,
    stage: a.stage as Application['stage'],
    retryAt: retry > Date.now() ? new Date(retry).toISOString() : null,
    quizSeed: Number(a.id) + a.quiz_seed,
    interviewAt: a.interview_at ? new Date(a.interview_at).toISOString() : null,
  };
}

/** The phone's Faction app: membership (with the rank's title) or the application in hand. */
export async function factionStatus(db: Db, privyUser: string) {
  const me = await byPrivy(db, privyUser);
  const membership = await memberOf(db, me.id);
  const application = membership ? null : await openApplication(db, me.id);
  let roster: { name: string; rank: number }[] = [];
  if (membership) {
    const r = await db.query<{ name: string; rank: number }>(
      `select c.name, m.rank from memberships m join characters c on c.account_id = m.account_id
       where m.faction = $1 order by m.rank desc, c.name limit 200`,
      [membership.faction],
    );
    roster = r.rows;
  }
  return {
    membership: membership && { ...membership, title: rankOf(membership)?.title ?? '' },
    application,
    roster,
  };
}

/** Is this character the city's overall boss, who runs every faction's applications? */
function bossOfAll(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === OVERALL_BOSS || superAdmins().has(lower);
}

/** The factions whose applications someone may read and decide. */
async function deskFactions(db: Db | Tx, who: Person): Promise<FactionId[]> {
  if (bossOfAll(who.name)) return [...FACTION_IDS];
  const m = await memberOf(db, who.id);
  return m && hasPower(m, 'recruit') ? [m.faction] : [];
}

/** The computer in a faction's building: who has applied, and where each one stands. */
export async function deskStatus(db: Db, privyUser: string) {
  const me = await byPrivy(db, privyUser);
  const factions = await deskFactions(db, me);
  const a = await db.query<{
    name: string;
    faction: string;
    stage: string;
    note: string;
    interview_at: Date | null;
  }>(
    `select c.name, a.faction, a.stage, a.note, a.interview_at from applications a
     join characters c on c.account_id = a.account_id
     where a.faction = any($1) and a.stage in ('training', 'interview')
     order by a.interview_at nulls last, a.id limit 100`,
    [factions],
  );
  return {
    factions,
    applicants: a.rows.map((r) => ({
      name: r.name,
      faction: r.faction,
      stage: r.stage,
      note: r.note,
      interviewAt: r.interview_at ? new Date(r.interview_at).toISOString() : null,
    })),
  };
}

/** Sets an applicant's interview `minutes` from now, at the faction's building. */
export async function scheduleInterview(
  db: Db,
  input: { actor?: unknown; name?: unknown; minutes?: unknown },
): Promise<{ name: string; faction: FactionId; at: string }> {
  const actor = await byAccount(db, input.actor);
  const them = await byName(db, input.name);
  const app = await openApplication(db, them.id);
  if (!app) throw new FactionError(`${them.name} hasn’t applied.`);
  if (!(await deskFactions(db, actor)).includes(app.faction))
    throw new FactionError('That application isn’t yours to handle.', 403);
  if (app.stage !== 'interview') throw new FactionError(`${them.name} hasn’t passed training yet.`);
  const minutes = Number(input.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60)
    throw new FactionError('When?');
  const at = new Date(Date.now() + minutes * 60_000);
  await db.query(
    `update applications set interview_at = $2, interview_by = $3
     where account_id = $1 and stage = 'interview'`,
    [them.id, at, actor.name],
  );
  await audit(db, app.faction, actor.name, 'schedule interview', them.name, at.toISOString());
  await notify(
    db,
    them.id,
    `${FACTIONS[app.faction].name}: your interview with ${actor.name} is at ${at.toUTCString()}.`,
  );
  return { name: them.name, faction: app.faction, at: at.toISOString() };
}

/** Applies to `faction` (with a short note): straight on to training. */
export async function applyTo(
  db: Db,
  privyUser: string,
  input: { faction?: unknown; note?: unknown },
) {
  const me = await byPrivy(db, privyUser);
  if (!isFactionId(input.faction)) throw new FactionError('Which faction?');
  if (await memberOf(db, me.id)) throw new FactionError('Leave your faction first.');
  if ((await db.query('select 1 from gang_members where account_id = $1', [me.id])).rowCount)
    throw new FactionError('Leave your gang first.');
  const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : '';
  const r = await db.query(
    `insert into applications (account_id, faction, stage, note) values ($1, $2, 'training', $3)
     on conflict do nothing`,
    [me.id, input.faction, note.slice(0, 300)],
  );
  if (!r.rowCount) throw new FactionError('You already have an application in.');
  await audit(db, input.faction, me.name, 'apply', me.name, note);
  return factionStatus(db, privyUser);
}

/** Withdraws an open application, or leaves the faction. */
export async function leave(db: Db, privyUser: string) {
  const me = await byPrivy(db, privyUser);
  const m = await memberOf(db, me.id);
  if (m) {
    await db.query('delete from memberships where account_id = $1', [me.id]);
    await audit(db, m.faction, me.name, 'leave', me.name);
  }
  await db.query(
    `update applications set stage = 'withdrawn', decided_at = now()
     where account_id = $1 and stage in ('training', 'interview')`,
    [me.id],
  );
  return factionStatus(db, privyUser);
}

/** Training: the quiz, graded here. Passing moves the application on to the interview. */
export async function takeQuiz(db: Db, privyUser: string, input: { answers?: unknown }) {
  const me = await byPrivy(db, privyUser);
  const app = await openApplication(db, me.id);
  if (!app || app.stage !== 'training') throw new FactionError('No training to do.');
  if (app.retryAt) throw new FactionError('Read up on the rules and try again a bit later.', 429);
  const answers = Array.isArray(input.answers) ? input.answers : [];
  const quiz = quizFor(app.faction, app.quizSeed);
  const right = quiz.filter((q, i) => answers[i] === q.answer).length;
  const passed = right >= QUIZ.pass;
  await db.query(
    passed
      ? `update applications set stage = 'interview' where account_id = $1 and stage = 'training'`
      : `update applications set quiz_failed_at = now(), quiz_seed = quiz_seed + 1
         where account_id = $1 and stage = 'training'`,
    [me.id],
  );
  await audit(
    db,
    app.faction,
    me.name,
    passed ? 'training passed' : 'training failed',
    me.name,
    `${right}/${quiz.length}`,
  );
  return { right, of: quiz.length, passed, status: await factionStatus(db, privyUser) };
}

async function actorIn(db: Db | Tx, account: unknown) {
  const actor = await byAccount(db, account);
  const m = await memberOf(db, actor.id);
  if (!m) throw new FactionError('You’re not in a faction.', 403);
  return { actor, m };
}

/**
 * After the interview: a recruiter (rank with 'recruit') of the faction applied to accepts or
 * turns down an applicant who passed training.
 */
export async function decide(
  db: Db,
  input: { actor?: unknown; name?: unknown; accept?: unknown },
): Promise<{ name: string; faction: FactionId; accepted: boolean }> {
  return inTx(db, async (tx) => {
    const actor = await byAccount(tx, input.actor);
    const allowed = await deskFactions(tx, actor);
    if (allowed.length === 0) {
      if (!(await memberOf(tx, actor.id))) throw new FactionError('You’re not in a faction.', 403);
      throw new FactionError('Your rank can’t take recruits on.', 403);
    }
    const them = await byName(tx, input.name);
    const app = await openApplication(tx, them.id);
    if (!app || !allowed.includes(app.faction))
      throw new FactionError(`${them.name} hasn’t applied to you.`);
    const m = { faction: app.faction };
    if (app.stage !== 'interview')
      throw new FactionError(`${them.name} hasn’t passed training yet.`);
    const accepted = input.accept !== false;
    await tx.query(
      `update applications set stage = $2, decided_by = $3, decided_at = now()
       where account_id = $1 and stage = 'interview'`,
      [them.id, accepted ? 'accepted' : 'rejected', actor.id],
    );
    if (accepted)
      await tx.query('insert into memberships (account_id, faction, rank) values ($1, $2, 1)', [
        them.id,
        m.faction,
      ]);
    await audit(tx, m.faction, actor.name, accepted ? 'accept' : 'reject', them.name);
    await notify(
      tx,
      them.id,
      accepted
        ? `You're in: welcome to ${FACTIONS[m.faction].name} (${actor.name}).`
        : `${FACTIONS[m.faction].name} turned your application down.`,
    );
    return { name: them.name, faction: m.faction, accepted };
  });
}

/** Promotes (+1) or demotes (-1) a member below the actor's rank, never to it. */
export async function setRank(
  db: Db,
  input: { actor?: unknown; name?: unknown; by?: unknown },
): Promise<{ name: string; rank: number; title: string }> {
  return inTx(db, async (tx) => {
    const { actor, m } = await actorIn(tx, input.actor);
    if (!hasPower(m, 'promote')) throw new FactionError('Your rank can’t change ranks.', 403);
    const them = await byName(tx, input.name);
    const t = await memberOf(tx, them.id);
    if (!t || t.faction !== m.faction) throw new FactionError(`${them.name} isn’t one of yours.`);
    if (t.rank >= m.rank) throw new FactionError('Only for those below you.', 403);
    const rank = t.rank + (input.by === -1 ? -1 : 1);
    if (rank < 1) throw new FactionError('Already the lowest rank.');
    if (rank >= m.rank) throw new FactionError('Not up to your own rank.', 403);
    await tx.query('update memberships set rank = $2 where account_id = $1', [them.id, rank]);
    await notify(
      tx,
      them.id,
      `${actor.name} made you ${rankOf({ faction: m.faction, rank })?.title ?? `rank ${rank}`}.`,
    );
    await audit(
      tx,
      m.faction,
      actor.name,
      input.by === -1 ? 'demote' : 'promote',
      them.name,
      `rank ${rank}`,
    );
    return { name: them.name, rank, title: rankOf({ faction: m.faction, rank })?.title ?? '' };
  });
}

/** Dismisses a member below the actor's rank. */
export async function dismiss(
  db: Db,
  input: { actor?: unknown; name?: unknown },
): Promise<{ name: string }> {
  return inTx(db, async (tx) => {
    const { actor, m } = await actorIn(tx, input.actor);
    if (!hasPower(m, 'dismiss')) throw new FactionError('Your rank can’t dismiss.', 403);
    const them = await byName(tx, input.name);
    const t = await memberOf(tx, them.id);
    if (!t || t.faction !== m.faction) throw new FactionError(`${them.name} isn’t one of yours.`);
    if (t.rank >= m.rank) throw new FactionError('Only for those below you.', 403);
    await tx.query('delete from memberships where account_id = $1', [them.id]);
    await audit(tx, m.faction, actor.name, 'dismiss', them.name);
    await notify(tx, them.id, `${actor.name} dismissed you from ${FACTIONS[m.faction].name}.`);
    return { name: them.name };
  });
}

/** The super admin appoints a faction's boss (its top rank), the first one or a new one. */
export async function appointBoss(
  db: Db,
  input: { name?: unknown; faction?: unknown; actor?: unknown },
): Promise<{ name: string; faction: FactionId; title: string }> {
  if (!isFactionId(input.faction))
    throw new FactionError('Which faction? police, medical, vipers or kings.');
  const faction = input.faction;
  return inTx(db, async (tx) => {
    const them = await byName(tx, input.name);
    const top = FACTIONS[faction].ranks.length;
    await tx.query(
      `insert into memberships (account_id, faction, rank) values ($1, $2, $3)
       on conflict (account_id) do update set faction = $2, rank = $3, joined_at = now()`,
      [them.id, faction, top],
    );
    await tx.query(
      `update applications set stage = 'withdrawn', decided_at = now()
       where account_id = $1 and stage in ('training', 'interview')`,
      [them.id],
    );
    await audit(
      tx,
      faction,
      typeof input.actor === 'string' ? input.actor : 'admin',
      'appoint boss',
      them.name,
    );
    await notify(tx, them.id, `You now lead ${FACTIONS[faction].name}.`);
    return { name: them.name, faction, title: FACTIONS[faction].ranks[top - 1]?.title ?? '' };
  });
}

/** An on-duty police officer with 'fine' fines someone (money to the fees sink). */
export async function fine(
  db: Db,
  input: { actor?: unknown; name?: unknown; cents?: unknown; reason?: unknown; key?: unknown },
): Promise<{ name: string; cents: number; account: string }> {
  const cents = input.cents;
  if (
    typeof cents !== 'number' ||
    !Number.isSafeInteger(cents) ||
    cents < FINE.min ||
    cents > FINE.max
  )
    throw new FactionError(`Fines are $${FINE.min / 100} to $${FINE.max / 100}.`);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 120) : '';
  if (!reason) throw new FactionError('Give a reason.');
  if (typeof input.key !== 'string' || !/^[\w:-]{8,96}$/.test(input.key))
    throw new FactionError('Bad key.');
  const { actor, m } = await actorIn(db, input.actor);
  if (FACTIONS[m.faction].kind !== 'police' || !hasPower(m, 'fine'))
    throw new FactionError('Only police officers can fine.', 403);
  const them = await byName(db, input.name);
  if (them.id === actor.id) throw new FactionError('Not yourself.');
  try {
    await inTx(db, (tx) =>
      spend(tx, {
        accountId: them.id,
        sink: 'fees',
        cents,
        key: `fine:${input.key as string}`,
        kind: 'fine',
        memo: { by: actor.name, reason },
      }),
    );
  } catch (e) {
    if (e instanceof InsufficientFunds)
      throw new FactionError(`${them.name} can’t pay that much.`, 402);
    if (e instanceof AccountFrozen || e instanceof EconomyPaused)
      throw new FactionError(e.message, 403);
    if (e instanceof LedgerError) throw new FactionError('That fine didn’t go through.', 409);
    throw e;
  }
  await audit(db, m.faction, actor.name, 'fine', them.name, `$${cents / 100}: ${reason}`);
  await notify(db, them.id, `Fined $${cents / 100} by ${actor.name}: ${reason}`);
  return { name: them.name, cents, account: them.id };
}

/** An ID check: name, age, whether they hold a pistol licence, their faction. */
export async function idCard(db: Db, input: { name?: unknown }) {
  const them = await byName(db, input.name);
  const r = await db.query<{ age: number }>('select age from characters where account_id = $1', [
    them.id,
  ]);
  const lic = await db.query(
    "select 1 from inventory where account_id = $1 and item = 'licence' and count > 0",
    [them.id],
  );
  const m = await memberOf(db, them.id);
  return {
    name: them.name,
    age: r.rows[0]?.age ?? 0,
    licence: (lic.rowCount ?? 0) > 0,
    faction: m ? `${FACTIONS[m.faction].short} ${rankOf(m)?.title ?? ''}` : null,
  };
}
