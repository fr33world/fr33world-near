/**
 * Rewards (Phase 6): what the world server gives for validated activity (a delivery, ore sold,
 * a tutorial step), as money from a faucet and experience together, in one transaction under
 * one key, so a replayed completion rewards once. Money keeps the faucet's caps (economy.ts);
 * XP keeps its source's hourly cap (shared XP_SOURCES), so repeated low-effort actions can't
 * farm levels. The history is what the phone's progress app shows.
 */
import { addGangPoints } from './gangs.ts';
import { type FaucetName, levelOf, XP_SOURCES, type XpSource } from '@fr33world/shared';
import { type Db, inTx } from './db.ts';
import { earn, FaucetCapped } from './economy.ts';
import { LedgerError } from './ledger.ts';

export class RewardError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface Rewarded {
  status: 'given' | 'duplicate';
  /** What was actually given (caps may cut it). */
  cents: number;
  xp: number;
  totalXp: number;
  level: number;
  levelUp: boolean;
}

/** The faucet a reward source's money comes from. */
const FAUCET_OF: Record<XpSource, FaucetName> = {
  jobs: 'jobs',
  tutorial: 'tutorial',
  faction: 'salary',
};

export async function reward(
  db: Db,
  input: {
    account?: unknown;
    source?: unknown;
    cents?: unknown;
    xp?: unknown;
    reason?: unknown;
    key?: unknown;
  },
): Promise<Rewarded> {
  const source = input.source as XpSource;
  const rules = XP_SOURCES[source];
  if (!rules) throw new RewardError(`no reward source ${String(input.source)}`);
  const cents = input.cents ?? 0;
  const xp = input.xp ?? 0;
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents < 0)
    throw new RewardError('bad cents');
  if (typeof xp !== 'number' || !Number.isSafeInteger(xp) || xp < 0 || xp > rules.maxAward)
    throw new RewardError('bad xp');
  if (typeof input.key !== 'string' || !/^[\w:.-]{6,160}$/.test(input.key))
    throw new RewardError('bad key');
  if (typeof input.account !== 'string') throw new RewardError('which account?');
  const account = input.account;
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 120) : source;
  const key = `reward:${input.key}`;

  return inTx(db, async (tx) => {
    const char = await tx.query<{ xp: number }>(
      'select xp from characters where account_id = $1 for update',
      [account],
    );
    const row = char.rows[0];
    if (!row) throw new RewardError('no character', 404);
    const done = await tx.query<{ cents: number; xp: number }>(
      'select cents, xp from rewards where idempotency_key = $1',
      [key],
    );
    const prior = done.rows[0];
    if (prior)
      return {
        status: 'duplicate' as const,
        cents: prior.cents,
        xp: prior.xp,
        totalXp: row.xp,
        level: levelOf(row.xp).level,
        levelUp: false,
      };
    let paid = 0;
    if (cents > 0) {
      try {
        const r = await earn(tx, {
          accountId: account,
          faucet: FAUCET_OF[source],
          cents,
          key,
          actor: 'system:world',
          memo: { reason, note: reason },
        });
        paid = r.paid;
      } catch (e) {
        // Past the money cap the XP may still count; anything else fails the reward.
        if (!(e instanceof FaucetCapped)) throw e;
      }
    }
    const recent = await tx.query<{ xp: number }>(
      `select coalesce(sum(xp), 0)::int as xp from rewards
       where account_id = $1 and source = $2 and created_at > now() - interval '1 hour'`,
      [account, source],
    );
    const given = Math.max(0, Math.min(xp, rules.perHour - (recent.rows[0]?.xp ?? 0)));
    // A job's a point (more for a big one) for the gang its worker belongs to.
    if (source === 'jobs') await addGangPoints(tx, account, 1 + Math.floor(paid / 10_000));
    await tx.query(
      `insert into rewards (account_id, idempotency_key, source, reason, cents, xp)
       values ($1, $2, $3, $4, $5, $6)`,
      [account, key, source, reason, paid, given],
    );
    const before = levelOf(row.xp).level;
    const total = row.xp + given;
    if (given > 0)
      await tx.query('update characters set xp = $2, updated_at = now() where account_id = $1', [
        account,
        total,
      ]);
    const level = levelOf(total).level;
    return {
      status: 'given' as const,
      cents: paid,
      xp: given,
      totalXp: total,
      level,
      levelUp: level > before,
    };
  }).catch((e: unknown) => {
    if (e instanceof LedgerError && !(e instanceof RewardError))
      throw new RewardError(e.message, 409);
    throw e;
  });
}

/** Level, XP and the latest rewards, for the phone. */
export async function progress(db: Db, privyUser: string) {
  const r = await db.query<{ id: string; xp: number }>(
    `select a.id, coalesce(c.xp, 0)::bigint as xp from accounts a
     left join characters c on c.account_id = a.id where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me) throw new RewardError('Please log in again.', 401);
  const history = await db.query<{
    id: number;
    source: string;
    reason: string;
    cents: number;
    xp: number;
    at: string;
  }>(
    `select id, source, reason, cents, xp, created_at as at from rewards
     where account_id = $1 order by id desc limit 40`,
    [me.id],
  );
  return { xp: me.xp, ...levelOf(me.xp), history: history.rows };
}
