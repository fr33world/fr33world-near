/**
 * The in-game inbox (Phase 10): notices for a player that wait for them (accepted into a
 * faction, promoted, dismissed, fined), read on the phone. Kept 30 days.
 */
import type { Db, Tx } from './db.ts';

export async function notify(db: Db | Tx, account: string, text: string): Promise<void> {
  await db.query('insert into notices (account_id, text) values ($1, $2)', [
    account,
    text.slice(0, 200),
  ]);
}

/** The latest notices (newest first), and how many are unread; marks them read with `read`. */
export async function inbox(db: Db, privyUser: string, read = false) {
  const r = await db.query<{ id: string }>('select id from accounts where privy_user_id = $1', [
    privyUser,
  ]);
  const account = r.rows[0]?.id;
  if (!account) return { notices: [], unread: 0 };
  await db.query("delete from notices where account_id = $1 and at < now() - interval '30 days'", [
    account,
  ]);
  const list = await db.query<{ id: number; text: string; at: string; read: boolean }>(
    'select id, text, at, read from notices where account_id = $1 order by id desc limit 50',
    [account],
  );
  const unread = list.rows.filter((n) => !n.read).length;
  if (read && unread)
    await db.query('update notices set read = true where account_id = $1', [account]);
  return { notices: list.rows, unread };
}
