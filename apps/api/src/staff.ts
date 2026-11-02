/**
 * Staff, bans and the audit log (Phase 4). The super admin is named by character in the
 * SUPER_ADMINS setting (comma-separated); admins are rows the super admin adds, each with the
 * powers given them. The world server makes the changes on staff's chat commands, calling the
 * internal routes with the key derived from the ticket secret; every change is logged.
 */
import { ALL_PERMISSIONS, isPermission, type Staff, type StaffPermission } from '@fr33world/shared';
import type { Db } from './db.ts';

/** Character names (lower case) of the super admins, from the SUPER_ADMINS setting. */
export function superAdmins(setting = process.env.SUPER_ADMINS ?? ''): Set<string> {
  return new Set(
    setting
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );
}

export class StaffError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** An account's staff role, if any. */
export async function staffOf(
  db: Db,
  accountId: string,
  characterName: string | null,
  supers: Set<string>,
): Promise<Staff | null> {
  if (characterName && supers.has(characterName.toLowerCase()))
    return { role: 'super', permissions: [...ALL_PERMISSIONS] };
  const r = await db.query<{ permissions: string[] }>(
    'select permissions from staff where account_id = $1',
    [accountId],
  );
  const row = r.rows[0];
  return row ? { role: 'admin', permissions: row.permissions.filter(isPermission) } : null;
}

/** A ban in force on an account: its reason and end (null: for good). */
export async function banOf(
  db: Db,
  accountId: string,
): Promise<{ reason: string; until: string | null } | null> {
  const r = await db.query<{ reason: string; until: string | null }>(
    `select reason, to_char(until at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"') as until
       from bans where account_id = $1 and (until is null or until > now())`,
    [accountId],
  );
  return r.rows[0] ?? null;
}

/** The account behind a character name. */
export async function accountOfName(db: Db, name: unknown): Promise<{ id: string; name: string }> {
  if (typeof name !== 'string' || !name.trim()) throw new StaffError('Which player?');
  const r = await db.query<{ id: string; name: string }>(
    'select account_id as id, name from characters where lower(name) = lower($1)',
    [name.trim()],
  );
  const row = r.rows[0];
  if (!row) throw new StaffError(`No player called ${name.trim()}.`, 404);
  return row;
}

/** Whether the acting account is a super admin (by its character's name). */
async function isSuper(db: Db, actor: string, supers: Set<string>): Promise<boolean> {
  const r = await db.query<{ name: string }>('select name from characters where account_id = $1', [
    actor,
  ]);
  const name = r.rows[0]?.name;
  return !!name && supers.has(name.toLowerCase());
}

/** The acting account's powers, as the API sees them now (the world's copy may be older). */
export async function actorCan(db: Db, actor: string, p: StaffPermission, supers: Set<string>) {
  if (await isSuper(db, actor, supers)) return true;
  const r = await db.query<{ permissions: string[] }>(
    'select permissions from staff where account_id = $1',
    [actor],
  );
  return r.rows[0]?.permissions.includes(p) ?? false;
}

export async function audit(
  db: Db,
  actor: string | null,
  action: string,
  target = '',
  details = '',
) {
  await db.query(
    'insert into staff_audit (actor, action, target, details) values ($1, $2, $3, $4)',
    [actor, action.slice(0, 40), target.slice(0, 80), details.slice(0, 500)],
  );
}

/** The super admin makes someone an admin with these powers (empty: no longer staff). */
export async function setStaff(
  db: Db,
  actor: string,
  input: { name?: unknown; permissions?: unknown },
  supers: Set<string>,
): Promise<{ name: string; permissions: StaffPermission[] }> {
  if (!(await isSuper(db, actor, supers)))
    throw new StaffError('Only the super admin can change staff.', 403);
  const target = await accountOfName(db, input.name);
  const permissions = Array.isArray(input.permissions)
    ? [...new Set(input.permissions.filter(isPermission))]
    : [];
  if (permissions.length === 0) {
    await db.query('delete from staff where account_id = $1', [target.id]);
  } else {
    await db.query(
      `insert into staff (account_id, permissions, added_by) values ($1, $2, $3)
       on conflict (account_id) do update set permissions = excluded.permissions`,
      [target.id, permissions, actor],
    );
  }
  await audit(
    db,
    actor,
    permissions.length ? 'staff.set' : 'staff.remove',
    target.name,
    permissions.join(','),
  );
  return { name: target.name, permissions };
}

export async function listStaff(db: Db) {
  const r = await db.query<{ name: string; permissions: string[] }>(
    `select c.name, s.permissions from staff s join characters c on c.account_id = s.account_id
     order by c.name`,
  );
  return r.rows;
}

/** Bans a player for `hours` (0 or missing: for good), or lifts their ban. */
export async function setBan(
  db: Db,
  actor: string,
  input: { name?: unknown; hours?: unknown; reason?: unknown; lift?: unknown },
  supers: Set<string>,
): Promise<{ name: string; account: string; until: string | null }> {
  if (!(await actorCan(db, actor, 'ban', supers)))
    throw new StaffError("You can't ban players.", 403);
  const target = await accountOfName(db, input.name);
  if (await isSuper(db, target.id, supers))
    throw new StaffError("The super admin can't be banned.", 403);
  if (input.lift === true) {
    await db.query('delete from bans where account_id = $1', [target.id]);
    await audit(db, actor, 'unban', target.name);
    return { name: target.name, account: target.id, until: null };
  }
  const hours =
    typeof input.hours === 'number' && input.hours > 0
      ? Math.max(1, Math.min(Math.round(input.hours), 24 * 365))
      : 0;
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const r = await db.query<{ until: string | null }>(
    `insert into bans (account_id, until, reason, banned_by)
       values ($1, case when $2 > 0 then now() + make_interval(hours => $2) end, $3, $4)
     on conflict (account_id) do update
       set until = excluded.until, reason = excluded.reason, banned_by = excluded.banned_by,
           created_at = now()
     returning to_char(until at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"') as until`,
    [target.id, hours, reason, actor],
  );
  await audit(
    db,
    actor,
    'ban',
    target.name,
    `${hours ? `${hours} h` : 'for good'}${reason ? `: ${reason}` : ''}`,
  );
  return { name: target.name, account: target.id, until: r.rows[0]?.until ?? null };
}

export async function recentAudit(db: Db) {
  const r = await db.query(
    `select a.created_at, coalesce(c.name, '(server)') as actor, a.action, a.target, a.details
       from staff_audit a left join characters c on c.account_id = a.actor
     order by a.created_at desc limit 300`,
  );
  return r.rows as Record<string, unknown>[];
}
