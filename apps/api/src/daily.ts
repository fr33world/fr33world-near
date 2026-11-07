/**
 * Daily rewards (rules in shared daily.ts): what's waiting, and claiming it. A claim takes its
 * key in `daily_claims` first, so a double tap or a race pays once, then pays through reward(),
 * which holds it to the daily faucet's caps and the XP limits. The spin is rolled here, never
 * on the client. In-game `$`, XP and items only: no path from here reaches USDC.
 */
import { randomInt } from 'node:crypto';
import {
  CARE,
  DAILY_TASKS,
  dayOf,
  levelOf,
  levelPrize,
  LOGIN_STREAK,
  nextStreak,
  type Prize,
  SPIN,
  SPIN_TOTAL,
  spinPrize,
  type TaskId,
} from '@fr33world/shared';
import { add } from './armory.ts';
import { BankError } from './bank.ts';
import type { Db } from './db.ts';
import { inTx } from './db.ts';
import { reward, RewardError } from './rewards.ts';

const today = (now = new Date()) => dayOf(now);

async function me(db: Db, privyUser: string) {
  const r = await db.query<{ id: string; xp: string | null }>(
    `select a.id, c.xp from accounts a left join characters c on c.account_id = a.id
     where a.privy_user_id = $1`,
    [privyUser],
  );
  const row = r.rows[0];
  if (!row) throw new BankError('Please log in again.', 401);
  if (row.xp === null) throw new BankError('Make your character first.', 403);
  return { id: row.id, level: levelOf(Number(row.xp)).level };
}

/** How far along each of today's tasks is. */
async function taskProgress(db: Db, account: string, day: string): Promise<Record<TaskId, number>> {
  const r = await db.query<{ steps: number; cents: string; bought: number }>(
    `select
       (select count(*)::int from rewards where account_id = $1 and source = 'jobs'
          and created_at >= $2::date and created_at < $2::date + 1) as steps,
       (select coalesce(sum(cents), 0)::bigint from rewards where account_id = $1
          and source = 'jobs' and created_at >= $2::date and created_at < $2::date + 1) as cents,
       (select count(*)::int from business_sales where buyer = $1 and status = 'confirmed'
          and created_at >= $2::date and created_at < $2::date + 1) as bought`,
    [account, day],
  );
  const row = r.rows[0];
  return { work: row?.steps ?? 0, earn: Number(row?.cents ?? 0), shop: row?.bought ?? 0 };
}

/** Everything the phone's Rewards app shows. */
export async function dailyStatus(db: Db, privyUser: string, now = new Date()) {
  const { id, level } = await me(db, privyUser);
  const day = today(now);
  const claims = await db.query<{ key: string; kind: string; streak: number; at: Date }>(
    `select key, kind, streak, created_at as at from daily_claims where account_id = $1
     and (kind = 'level' or created_at > now() - interval '3 days')`,
    [id],
  );
  const has = new Set(claims.rows.map((c) => c.key));
  const logins = claims.rows
    .filter((c) => c.kind === 'login')
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const last = logins[0];
  const lastDay = last ? { day: dayOf(last.at), streak: last.streak } : null;
  const claimedToday = has.has(`login:${day}`);
  const progress = await taskProgress(db, id, day);
  const levels: number[] = [];
  for (let l = 2; l <= level; l += 1) if (!has.has(`level:${l}`)) levels.push(l);
  return {
    day,
    login: {
      claimed: claimedToday,
      /** The streak day shown: today's, claimed or not. */
      streak: claimedToday ? (lastDay?.streak ?? 1) : nextStreak(lastDay, day),
    },
    spin: { claimed: has.has(`spin:${day}`) },
    tasks: DAILY_TASKS.map((t) => ({
      id: t.id,
      done: Math.min(progress[t.id], t.need),
      claimed: has.has(`task:${t.id}:${day}`),
    })),
    levels: levels.slice(0, 10),
  };
}

async function pay(
  db: Db,
  account: string,
  key: string,
  kind: string,
  streak: number,
  prize: Prize,
  reason: string,
) {
  const taken = await db.query(
    `insert into daily_claims (account_id, key, kind, streak) values ($1, $2, $3, $4)
     on conflict do nothing`,
    [account, key, kind, streak],
  );
  if (taken.rowCount === 0) throw new BankError('Already claimed.', 409);
  try {
    const paid = await reward(db, {
      account,
      source: 'daily',
      cents: prize.cents ?? 0,
      xp: prize.xp ?? 0,
      reason,
      key: `daily:${account}:${key}`,
    });
    if (prize.item) await inTx(db, (tx) => add(tx, account, `care:${prize.item}`, 1, CARE.max));
    return { ...prize, cents: paid.cents, xp: paid.xp, totalXp: paid.totalXp };
  } catch (e) {
    // Nothing was paid, so the claim goes back and can be tried again.
    await db.query('delete from daily_claims where account_id = $1 and key = $2', [account, key]);
    if (e instanceof RewardError) throw new BankError(e.message, e.status);
    throw e;
  }
}

/** Claims one reward: `what` is 'login', 'spin', a task id, or `level` with `level`. */
export async function claimDaily(
  db: Db,
  privyUser: string,
  body: { what?: unknown; level?: unknown },
  roll: (total: number) => number = (n) => randomInt(n),
  now = new Date(),
) {
  const { id, level } = await me(db, privyUser);
  const day = today(now);
  const what = body.what;
  if (what === 'login') {
    const s = await dailyStatus(db, privyUser, now);
    const prize = LOGIN_STREAK[s.login.streak - 1] as Prize;
    return pay(
      db,
      id,
      `login:${day}`,
      'login',
      s.login.streak,
      prize,
      `Daily login: day ${s.login.streak}`,
    );
  }
  if (what === 'spin') {
    const i = spinPrize(roll(SPIN_TOTAL));
    const prize = SPIN[i] as (typeof SPIN)[number];
    const paid = await pay(db, id, `spin:${day}`, 'spin', 0, prize, `Daily spin: ${prize.label}`);
    return { ...paid, slice: i };
  }
  if (what === 'level') {
    const l = body.level;
    if (typeof l !== 'number' || !Number.isInteger(l) || l < 2 || l > level)
      throw new BankError('Not reached yet.');
    return pay(db, id, `level:${l}`, 'level', 0, levelPrize(l), `Level ${l} bonus`);
  }
  const task = DAILY_TASKS.find((t) => t.id === what);
  if (!task) throw new BankError('Nothing like that to claim.');
  if ((await taskProgress(db, id, day))[task.id] < task.need)
    throw new BankError('Not finished yet.');
  return pay(db, id, `task:${task.id}:${day}`, 'task', 0, task.prize, `Daily task: ${task.name}`);
}
