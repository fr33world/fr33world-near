/**
 * Gangs players start themselves, and the weekly board (owner, 2026-10-31; shared GANG). Starting
 * one takes a level and money into the purchases sink; others ask to join and the leader says
 * yes. Members' jobs score for their gang, the Vipers and Kings too. A gang shows on the board
 * once it has enough members.
 */
import {
  type FactionId,
  FACTIONS,
  GANG,
  gangNameProblem,
  isFactionId,
  levelOf,
} from '@fr33world/shared';
import { BankError } from './bank.ts';
import { type Db, inTx, type Tx } from './db.ts';
import { spend } from './economy.ts';
import { memberOf } from './factions.ts';
import { notify } from './inbox.ts';
import { AccountFrozen, EconomyPaused, InsufficientFunds, LedgerError } from './ledger.ts';

export class GangError extends BankError {}

export interface BoardRow {
  name: string;
  tag: string;
  members: number;
  points: number;
}

async function me(db: Db | Tx, privyUser: string) {
  const r = await db.query<{ id: string; name: string; xp: string }>(
    `select a.id, c.name, c.xp from accounts a join characters c on c.account_id = a.id
     where a.privy_user_id = $1`,
    [privyUser],
  );
  const row = r.rows[0];
  if (!row) throw new GangError('Make a character first.', 404);
  return { id: row.id, name: row.name, xp: Number(row.xp) };
}

/** This week's board, top first: the starter gangs, and player gangs with enough members. */
export async function board(db: Db | Tx): Promise<BoardRow[]> {
  const scores = await db.query<{ gang: string; points: number }>(
    `select gang, points from gang_scores where week = date_trunc('week', now())::date`,
  );
  const points = new Map(scores.rows.map((s) => [s.gang, s.points]));
  const starters = await db.query<{ faction: string; members: number }>(
    `select faction, count(*)::int as members from memberships
     where faction in ('vipers', 'kings') group by faction`,
  );
  const rows: BoardRow[] = (['vipers', 'kings'] as FactionId[]).map((id) => ({
    name: FACTIONS[id].name,
    tag: FACTIONS[id].short,
    members: starters.rows.find((s) => s.faction === id)?.members ?? 0,
    points: points.get(id) ?? 0,
  }));
  const gangs = await db.query<{ id: string; name: string; tag: string; members: number }>(
    `select g.id, g.name, g.tag, count(m.*)::int as members from gangs g
     join gang_members m on m.gang_id = g.id and m.accepted
     group by g.id having count(m.*) >= $1`,
    [GANG.minMembers],
  );
  for (const g of gangs.rows)
    rows.push({
      name: g.name,
      tag: g.tag,
      members: g.members,
      points: points.get(`g${g.id}`) ?? 0,
    });
  return rows.sort((a, b) => b.points - a.points || b.members - a.members).slice(0, 20);
}

/** The phone: your gang (with the requests, for its leader), the others, and the board. */
export async function gangStatus(db: Db, privyUser: string) {
  const you = await me(db, privyUser);
  const mine = await db.query<{
    id: string;
    name: string;
    tag: string;
    leader: string;
    accepted: boolean;
  }>(
    `select g.id, g.name, g.tag, g.leader, m.accepted from gang_members m
     join gangs g on g.id = m.gang_id where m.account_id = $1`,
    [you.id],
  );
  const g = mine.rows[0];
  let members: string[] = [];
  let requests: string[] = [];
  if (g?.accepted) {
    const r = await db.query<{ name: string; accepted: boolean }>(
      `select c.name, m.accepted from gang_members m
       join characters c on c.account_id = m.account_id where m.gang_id = $1 order by c.name`,
      [g.id],
    );
    members = r.rows.filter((x) => x.accepted).map((x) => x.name);
    if (g.leader === you.id) requests = r.rows.filter((x) => !x.accepted).map((x) => x.name);
  }
  const open = await db.query<{ id: string; name: string; tag: string; members: number }>(
    `select g.id, g.name, g.tag, count(m.*) filter (where m.accepted)::int as members
     from gangs g left join gang_members m on m.gang_id = g.id
     group by g.id order by members desc, g.name limit 30`,
  );
  return {
    gang: g
      ? {
          name: g.name,
          tag: g.tag,
          leader: g.leader === you.id,
          accepted: g.accepted,
          members,
          requests,
        }
      : null,
    gangs: open.rows.map((x) => ({
      id: Number(x.id),
      name: x.name,
      tag: x.tag,
      members: x.members,
    })),
    board: await board(db),
    level: levelOf(you.xp).level,
  };
}

/** Starts a gang: a level, the money, and neither in a faction nor in another gang. */
export async function createGang(
  db: Db,
  privyUser: string,
  input: { name?: unknown; tag?: unknown },
) {
  const you = await me(db, privyUser);
  if (levelOf(you.xp).level < GANG.minLevel)
    throw new GangError(`Starting a gang takes level ${GANG.minLevel}.`, 403);
  if (await memberOf(db, you.id)) throw new GangError('Leave your faction first.');
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  const tag = typeof input.tag === 'string' ? input.tag.trim().toUpperCase() : '';
  const problem = gangNameProblem(name, tag);
  if (problem) throw new GangError(problem);
  try {
    await inTx(db, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [you.id]);
      const inOne = await tx.query('select 1 from gang_members where account_id = $1', [you.id]);
      if (inOne.rowCount) throw new GangError('You’re already in a gang.');
      const taken = await tx.query(
        'select 1 from gangs where lower(name) = lower($1) or lower(tag) = lower($2)',
        [name, tag],
      );
      if (taken.rowCount) throw new GangError('That name or tag is taken.');
      await spend(tx, {
        accountId: you.id,
        sink: 'purchases',
        cents: GANG.price,
        key: `gang:${you.id}:${name.toLowerCase()}`,
        kind: 'gang',
        memo: { name },
      });
      const g = await tx.query<{ id: string }>(
        'insert into gangs (name, tag, leader) values ($1, $2, $3) returning id',
        [name, tag, you.id],
      );
      await tx.query(
        'insert into gang_members (account_id, gang_id, accepted) values ($1, $2, true)',
        [you.id, g.rows[0]?.id],
      );
    });
  } catch (e) {
    if (e instanceof InsufficientFunds)
      throw new GangError(
        `Starting a gang costs $${(GANG.price / 100).toLocaleString('en-US')}.`,
        402,
      );
    if (e instanceof AccountFrozen) throw new GangError(e.message, 403);
    if (e instanceof EconomyPaused) throw new GangError(e.message, 503);
    if (e instanceof LedgerError) throw new GangError('That didn’t go through.', 409);
    throw e;
  }
  return gangStatus(db, privyUser);
}

/** Asks to join a gang; the leader hears about it. */
export async function joinGang(db: Db, privyUser: string, input: { gang?: unknown }) {
  const you = await me(db, privyUser);
  if (await memberOf(db, you.id)) throw new GangError('Leave your faction first.');
  const id = Number(input.gang);
  const g = await db.query<{ leader: string; name: string }>(
    'select leader, name from gangs where id = $1',
    [Number.isSafeInteger(id) ? id : 0],
  );
  const gang = g.rows[0];
  if (!gang) throw new GangError('No such gang.');
  const r = await db.query(
    `insert into gang_members (account_id, gang_id) values ($1, $2) on conflict do nothing`,
    [you.id, id],
  );
  if (!r.rowCount) throw new GangError('You’re already in a gang, or have asked one.');
  await notify(db, gang.leader, `${you.name} asked to join ${gang.name}.`);
  return gangStatus(db, privyUser);
}

/** Leaves a gang, or withdraws a request. A leader leaving ends it if nobody's left. */
export async function leaveGang(db: Db, privyUser: string) {
  const you = await me(db, privyUser);
  await inTx(db, async (tx) => {
    const r = await tx.query<{ gang_id: string; leader: string }>(
      `delete from gang_members m using gangs g
       where m.account_id = $1 and g.id = m.gang_id returning m.gang_id, g.leader`,
      [you.id],
    );
    const left = r.rows[0];
    if (!left || left.leader !== you.id) return;
    // The longest-standing member takes over; with nobody left the gang ends.
    const next = await tx.query<{ account_id: string }>(
      `select account_id from gang_members where gang_id = $1 and accepted
       order by joined_at limit 1`,
      [left.gang_id],
    );
    const heir = next.rows[0];
    if (heir)
      await tx.query('update gangs set leader = $2 where id = $1', [left.gang_id, heir.account_id]);
    else await tx.query('delete from gangs where id = $1', [left.gang_id]);
  });
  return gangStatus(db, privyUser);
}

/** A leader says yes or no to someone who asked to join. */
export async function decideMember(
  db: Db,
  privyUser: string,
  input: { name?: unknown; accept?: unknown },
) {
  const you = await me(db, privyUser);
  const g = await db.query<{ id: string; name: string }>(
    'select id, name from gangs where leader = $1',
    [you.id],
  );
  const gang = g.rows[0];
  if (!gang) throw new GangError('Only a gang’s leader can do that.', 403);
  const r = await db.query<{ account_id: string }>(
    `select m.account_id from gang_members m join characters c on c.account_id = m.account_id
     where m.gang_id = $1 and not m.accepted and lower(c.name) = lower($2)`,
    [gang.id, typeof input.name === 'string' ? input.name : ''],
  );
  const them = r.rows[0];
  if (!them) throw new GangError('No such request.');
  if (input.accept === false)
    await db.query('delete from gang_members where account_id = $1', [them.account_id]);
  else
    await db.query('update gang_members set accepted = true where account_id = $1', [
      them.account_id,
    ]);
  await notify(
    db,
    them.account_id,
    input.accept === false ? `${gang.name} said no.` : `You're in ${gang.name}.`,
  );
  return gangStatus(db, privyUser);
}

/** Whether they're in a gang they started or joined (no faction applications then). */
export async function inPlayerGang(db: Db | Tx, account: string): Promise<boolean> {
  const r = await db.query('select 1 from gang_members where account_id = $1 and accepted', [
    account,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** Scores a job for the gang its worker belongs to, if any. */
export async function addGangPoints(tx: Tx, account: string, points: number): Promise<void> {
  const f = await memberOf(tx, account);
  let gang: string | null =
    f && isFactionId(f.faction) && FACTIONS[f.faction].kind === 'gang' ? f.faction : null;
  if (!gang) {
    const r = await tx.query<{ gang_id: string }>(
      'select gang_id from gang_members where account_id = $1 and accepted',
      [account],
    );
    if (r.rows[0]) gang = `g${r.rows[0].gang_id}`;
  }
  if (!gang) return;
  await tx.query(
    `insert into gang_scores (gang, week, points) values ($1, date_trunc('week', now())::date, $2)
     on conflict (gang, week) do update set points = gang_scores.points + $2`,
    [gang, points],
  );
}
