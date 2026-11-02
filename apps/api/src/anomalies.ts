/**
 * Anomaly flags (technical-plan §7.6), raised by a scan the invariant monitor runs with each
 * check (shared ANOMALY thresholds):
 *   velocity      earned from faucets in the last hour above every hourly cap together, or,
 *                 with enough earners, in the top 0.1%;
 *   large_balance a balance above the review threshold;
 *   pair          many payments between the same two players in a day (both flagged);
 *   fan_in        payments to one player from many senders in a day;
 *   round_trip    a large sum sent and sent back within a day (both flagged).
 * Each is one open flag per account and kind, refreshed by later findings, until an admin
 * reviews it (and may freeze the wallet: it can be paid but nothing leaves it).
 */
import { ANOMALY } from '@fr33world/shared';
import type { Db } from './db.ts';
import { setFrozen, walletOf } from './ledger.ts';

export type FlagKind = 'velocity' | 'large_balance' | 'pair' | 'fan_in' | 'round_trip';
type Thresholds = { -readonly [K in keyof typeof ANOMALY]: number };

export async function flag(
  db: Db,
  accountId: string,
  kind: FlagKind,
  details: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into economy_flags (account_id, kind, details) values ($1, $2, $3)
     on conflict (account_id, kind) where reviewed_at is null
     do update set details = excluded.details, updated_at = now()`,
    [accountId, kind, details],
  );
}

/** Runs every check; returns how many findings it flagged. */
export async function scan(db: Db, t: Thresholds = ANOMALY): Promise<number> {
  let found = 0;
  const raise = async (account: string, kind: FlagKind, details: Record<string, unknown>) => {
    found += 1;
    await flag(db, account, kind, details);
  };

  const velocity = await db.query<{ account: string; cents: number; p999: number; n: number }>(
    `with earned as (
       select w.account_id, sum(w.amount)::bigint as cents
       from ledger_entries w
       join ledger_accounts wa on wa.id = w.account_id and wa.kind = 'player'
       join ledger_entries f on f.tx_id = w.tx_id
       join ledger_accounts fa on fa.id = f.account_id and fa.kind = 'faucet'
         and fa.code not in ('faucet:signup', 'faucet:corrections')
       where w.amount > 0 and w.created_at > now() - interval '1 hour'
       group by w.account_id),
     p as (select percentile_cont(0.999) within group (order by cents) as p999, count(*) as n
           from earned)
     select la.owner_id as account, e.cents, p.p999, p.n
     from earned e join ledger_accounts la on la.id = e.account_id, p
     where e.cents > $1 or (p.n >= $2 and e.cents > p.p999)`,
    [t.earnedPerHour, t.percentileFrom],
  );
  for (const r of velocity.rows)
    await raise(r.account, 'velocity', { earnedLastHour: r.cents, p999: r.p999, earners: r.n });

  const rich = await db.query<{ account: string; balance: number }>(
    `select owner_id as account, balance from ledger_accounts
     where kind = 'player' and balance > $1`,
    [t.largeBalance],
  );
  for (const r of rich.rows) await raise(r.account, 'large_balance', { balance: r.balance });

  // Player-to-player payments in the last day: who paid whom, how often, how much.
  const pays = `
    with pay as (
      select sa.owner_id as sender, ra.owner_id as recipient, r.amount
      from ledger_transactions t
      join ledger_entries s on s.tx_id = t.id and s.amount < 0
      join ledger_accounts sa on sa.id = s.account_id and sa.kind = 'player'
      join ledger_entries r on r.tx_id = t.id and r.amount > 0
      join ledger_accounts ra on ra.id = r.account_id and ra.kind = 'player'
      where t.kind = 'payment' and t.created_at > now() - interval '1 day'),
    pairs as (
      select sender, recipient, count(*)::int as n, sum(amount)::bigint as cents
      from pay group by sender, recipient)`;
  const pairs = await db.query<{ sender: string; recipient: string; n: number; cents: number }>(
    `${pays} select * from pairs where n >= $1`,
    [t.pairPayments],
  );
  for (const r of pairs.rows) {
    const details = { from: r.sender, to: r.recipient, payments: r.n, cents: r.cents };
    await raise(r.sender, 'pair', details);
    await raise(r.recipient, 'pair', details);
  }
  const fanIn = await db.query<{ recipient: string; senders: number; cents: number }>(
    `${pays} select recipient, count(*)::int as senders, sum(cents)::bigint as cents
     from pairs group by recipient having count(*) >= $1`,
    [t.fanIn],
  );
  for (const r of fanIn.rows)
    await raise(r.recipient, 'fan_in', { senders: r.senders, cents: r.cents });
  const trips = await db.query<{ a: string; b: string; out: number; back: number }>(
    `${pays} select x.sender as a, x.recipient as b, x.cents as out, y.cents as back
     from pairs x join pairs y on y.sender = x.recipient and y.recipient = x.sender
     where x.cents >= $1 and y.cents >= $1 and x.sender < x.recipient`,
    [t.roundTrip],
  );
  for (const r of trips.rows) {
    const details = { a: r.a, b: r.b, aToB: r.out, bToA: r.back };
    await raise(r.a, 'round_trip', details);
    await raise(r.b, 'round_trip', details);
  }
  return found;
}

export interface OpenFlag {
  id: number;
  account: string;
  character: string | null;
  kind: FlagKind;
  details: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** The review queue: flags nobody has looked at yet, newest first. */
export async function openFlags(db: Db, limit = 100): Promise<OpenFlag[]> {
  const r = await db.query<OpenFlag>(
    `select f.id, f.account_id as account, c.name as character, f.kind, f.details,
            f.created_at, f.updated_at
     from economy_flags f left join characters c on c.account_id = f.account_id
     where f.reviewed_at is null order by f.updated_at desc limit $1`,
    [limit],
  );
  return r.rows;
}

/** Closes a flag with a note; `freeze` also freezes (or `thaw` thaws) the account's wallet. */
export async function reviewFlag(
  db: Db,
  id: number,
  by: string,
  opts: { note?: string; freeze?: boolean; thaw?: boolean },
): Promise<boolean> {
  const r = await db.query<{ account_id: string }>(
    `update economy_flags set reviewed_at = now(), reviewed_by = $2, note = $3
     where id = $1 and reviewed_at is null returning account_id`,
    [id, by, opts.note?.slice(0, 500) ?? null],
  );
  const row = r.rows[0];
  if (!row) return false;
  if (opts.freeze || opts.thaw)
    await setFrozen(db, await walletOf(db, row.account_id), !!opts.freeze);
  return true;
}
