/**
 * Player safety (Phase 4): blocks and reports, both by character name (names are unique, so
 * clients never learn anyone's account). A block hides that character's chat, voice and name
 * tag from the blocker (the client applies the list); a report is kept for admins.
 */
import type { Db } from './db.ts';

export const REPORT_REASONS = [
  'harassment',
  'hate',
  'cheating',
  'spam',
  'random_killing',
  'car_ramming',
  'other',
] as const;
/** At most this many blocks per account, and reports per account per day. */
export const MAX_BLOCKS = 500;
export const REPORTS_PER_DAY = 20;

export class SafetyError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The account behind a Privy user, and the character behind a name (either may be missing). */
async function who(db: Db, privyUser: string, name: unknown) {
  if (typeof name !== 'string' || !name.trim()) throw new SafetyError('Which player?');
  const r = await db.query<{ me: string | null; them: string | null; mine: string | null }>(
    `select (select id from accounts where privy_user_id = $1) as me,
            (select account_id from characters where lower(name) = lower($2)) as them,
            (select c.account_id from characters c join accounts a on a.id = c.account_id
               where a.privy_user_id = $1) as mine`,
    [privyUser, name.trim()],
  );
  const row = r.rows[0];
  if (!row?.me) throw new SafetyError('No account yet. Log in first.', 404);
  if (!row.them) throw new SafetyError('No player by that name.', 404);
  if (row.them === row.mine) throw new SafetyError("That's you.");
  return { me: row.me, them: row.them };
}

/** The names this account has blocked. */
export async function blockedNames(db: Db, privyUser: string): Promise<string[]> {
  const r = await db.query<{ name: string }>(
    `select c.name from blocks b
       join accounts a on a.id = b.account_id
       join characters c on c.account_id = b.blocked_character
     where a.privy_user_id = $1 order by b.created_at`,
    [privyUser],
  );
  return r.rows.map((x) => x.name);
}

export async function setBlocked(db: Db, privyUser: string, name: unknown, on: boolean) {
  const { me, them } = await who(db, privyUser, name);
  if (on) {
    const n = await db.query<{ n: number }>(
      'select count(*)::int as n from blocks where account_id = $1',
      [me],
    );
    if ((n.rows[0]?.n ?? 0) >= MAX_BLOCKS)
      throw new SafetyError('You have blocked too many players.');
    await db.query(
      'insert into blocks (account_id, blocked_character) values ($1, $2) on conflict do nothing',
      [me, them],
    );
  } else {
    await db.query('delete from blocks where account_id = $1 and blocked_character = $2', [
      me,
      them,
    ]);
  }
  return blockedNames(db, privyUser);
}

export async function report(
  db: Db,
  privyUser: string,
  input: { name?: unknown; reason?: unknown; details?: unknown },
): Promise<void> {
  const { me, them } = await who(db, privyUser, input.name);
  const reason = input.reason;
  if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason))
    throw new SafetyError('Choose a reason.');
  const details = typeof input.details === 'string' ? input.details.trim().slice(0, 500) : '';
  const recent = await db.query<{ n: number }>(
    `select count(*)::int as n from reports
     where reporter_id = $1 and created_at > now() - interval '1 day'`,
    [me],
  );
  if ((recent.rows[0]?.n ?? 0) >= REPORTS_PER_DAY)
    throw new SafetyError('You have sent a lot of reports today. Try again tomorrow.', 429);
  await db.query(
    'insert into reports (reporter_id, reported_character, reason, details) values ($1, $2, $3, $4)',
    [me, them, reason, details],
  );
}

/** The latest reports not yet reviewed, for admins. */
export interface OpenReport {
  id: string;
  reason: string;
  details: string;
  created_at: string;
  reporter: string | null;
  reported: string;
}

export async function openReports(db: Db): Promise<OpenReport[]> {
  const r = await db.query<OpenReport>(
    `select r.id, r.reason, r.details, r.created_at,
            reporter.name as reporter, reported.name as reported
       from reports r
       left join characters reporter on reporter.account_id = r.reporter_id
       join characters reported on reported.account_id = r.reported_character
     where not r.reviewed order by r.created_at desc limit 200`,
  );
  return r.rows;
}
