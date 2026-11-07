/**
 * Private messages (the phone's Messages app), by character name, so nobody learns an account.
 * Someone who has blocked you never gets your messages, and isn't told so: to the sender it reads
 * as sent. Only full accounts send, within a daily limit, because a throwaway guest is the easy
 * way to harass someone; anyone can read and block. Kept 30 days.
 */
import { BankError } from './bank.ts';
import type { Db } from './db.ts';

const MAX_CHARS = 300;
const PER_DAY = 300;
const UNSHOWABLE = /[\p{Cc}\p{Cf}]/gu;

async function me(db: Db, privyUser: string) {
  const r = await db.query<{ id: string; is_guest: boolean; name: string | null }>(
    `select a.id, a.is_guest, c.name from accounts a
     left join characters c on c.account_id = a.id where a.privy_user_id = $1`,
    [privyUser],
  );
  const row = r.rows[0];
  if (!row) throw new BankError('Please log in again.', 401);
  return row;
}

async function them(db: Db, name: unknown) {
  if (typeof name !== 'string' || !name.trim()) throw new BankError('Who to?');
  const r = await db.query<{ account_id: string; name: string }>(
    'select account_id, name from characters where lower(name) = lower($1)',
    [name.trim()],
  );
  const row = r.rows[0];
  if (!row) throw new BankError('Nobody by that name.', 404);
  return row;
}

/** Everyone you've talked to, latest first, with the last line and how many are unread. */
export async function conversations(db: Db, privyUser: string) {
  const { id } = await me(db, privyUser);
  await db.query(
    `delete from messages where (from_account = $1 or to_account = $1)
       and at < now() - interval '30 days'`,
    [id],
  );
  const r = await db.query<{
    name: string;
    text: string;
    at: string;
    mine: boolean;
    unread: number;
  }>(
    `with mine as (
       select case when from_account = $1 then to_account else from_account end as other, *
       from messages where from_account = $1 or to_account = $1
     ), latest as (
       select distinct on (other) other, text, at, from_account = $1 as mine
       from mine order by other, id desc
     )
     select c.name, l.text, l.at, l.mine,
       (select count(*)::int from messages u where u.from_account = l.other
          and u.to_account = $1 and not u.read) as unread
     from latest l join characters c on c.account_id = l.other
     order by l.at desc limit 50`,
    [id],
  );
  return { conversations: r.rows, unread: r.rows.reduce((n, c) => n + c.unread, 0) };
}

/** The last messages with one person, oldest first; reading them marks them read. */
export async function thread(db: Db, privyUser: string, name: unknown) {
  const { id } = await me(db, privyUser);
  const other = await them(db, name);
  await db.query(
    'update messages set read = true where to_account = $1 and from_account = $2 and not read',
    [id, other.account_id],
  );
  const r = await db.query<{ id: number; text: string; at: string; mine: boolean }>(
    `select id, text, at, from_account = $1 as mine from messages
     where (from_account = $1 and to_account = $2) or (from_account = $2 and to_account = $1)
     order by id desc limit 60`,
    [id, other.account_id],
  );
  return { name: other.name, messages: r.rows.reverse() };
}

export async function sendMessage(
  db: Db,
  privyUser: string,
  body: { to?: unknown; text?: unknown },
) {
  const sender = await me(db, privyUser);
  if (sender.is_guest) throw new BankError('Make a full account to send messages.', 403);
  if (!sender.name) throw new BankError('Make your character first.', 403);
  const other = await them(db, body.to);
  if (other.account_id === sender.id) throw new BankError('That’s you.');
  const text = typeof body.text === 'string' ? body.text.replace(UNSHOWABLE, ' ').trim() : '';
  if (!text) throw new BankError('Say something first.');
  if ([...text].length > MAX_CHARS) throw new BankError(`Up to ${MAX_CHARS} characters.`);
  const sent = await db.query<{ n: number }>(
    `select count(*)::int as n from messages
     where from_account = $1 and at > now() - interval '1 day'`,
    [sender.id],
  );
  if ((sent.rows[0]?.n ?? 0) >= PER_DAY)
    throw new BankError('That’s enough messages for today.', 429);
  const blocked = await db.query(
    'select 1 from blocks where account_id = $1 and blocked_character = $2',
    [other.account_id, sender.id],
  );
  // Blocked: nothing is delivered, and the sender sees no difference.
  if (blocked.rowCount) return { id: 0, text, at: new Date().toISOString(), mine: true };
  const r = await db.query<{ id: number; at: string }>(
    `insert into messages (from_account, to_account, text) values ($1, $2, $3)
     returning id, at`,
    [sender.id, other.account_id, text],
  );
  return { ...r.rows[0], text, mine: true };
}
