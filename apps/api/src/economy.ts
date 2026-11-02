/**
 * Paying players and charging them (technical-plan §7): every reward comes from a faucet in
 * the shared config and is held to that faucet's per-character caps; every charge goes into a
 * sink. The wallet's row is locked first, so payouts racing each other queue up and none of
 * them sees the cap before another has counted. Amounts are always the server's own.
 */
import { FAUCETS, type Faucet, type FaucetName, SINKS, type SinkName } from '@fr33world/shared';
import type { Tx } from './db.ts';
import {
  LedgerError,
  post,
  type PostResult,
  type SystemAccount,
  systemAccount,
  walletOf,
} from './ledger.ts';

export class FaucetCapped extends LedgerError {
  constructor(faucet: string) {
    super(`The ${faucet} limit for now is reached`);
  }
}

export interface Earned extends PostResult {
  /** What was paid (less than asked when a cap cut it). */
  paid: number;
  /** A cap cut it short. */
  capped: boolean;
}

/** How much `wallet` has taken from `faucetAccount` in the last hour and day (cents). */
export async function takenFrom(
  tx: Tx,
  wallet: number,
  faucetAccount: number,
): Promise<{ hour: number; day: number }> {
  const r = await tx.query<{ hour: number; day: number }>(
    `select coalesce(sum(w.amount) filter (where w.created_at > now() - interval '1 hour'), 0)::bigint as hour,
            coalesce(sum(w.amount), 0)::bigint as day
     from ledger_entries w
     join ledger_entries f on f.tx_id = w.tx_id and f.account_id = $2
     where w.account_id = $1 and w.amount > 0 and w.created_at > now() - interval '1 day'`,
    [wallet, faucetAccount],
  );
  return r.rows[0] ?? { hour: 0, day: 0 };
}

/**
 * Pays `cents` from `faucet` to the player, inside the caller's transaction, cut down to what
 * their caps still allow (FaucetCapped when nothing is left). A key already paid answers
 * 'duplicate' with what it paid then.
 */
export async function earn(
  tx: Tx,
  req: {
    accountId: string;
    faucet: FaucetName;
    cents: number;
    key: string;
    memo?: Record<string, unknown>;
    actor?: string;
  },
  faucets: Record<string, Faucet> = FAUCETS,
): Promise<Earned> {
  const f = faucets[req.faucet];
  if (!f) throw new LedgerError(`no faucet ${req.faucet}`);
  if (!Number.isSafeInteger(req.cents) || req.cents <= 0 || req.cents > f.maxPayment)
    throw new LedgerError(`bad ${req.faucet} payment ${req.cents}`);
  const kind = `earn:${req.faucet}`;
  const wallet = await walletOf(tx, req.accountId);
  // One payout per wallet at a time from here to commit.
  await tx.query('select id from ledger_accounts where id = $1 for update', [wallet]);
  const prior = await tx.query<{ id: number; paid: number }>(
    `select t.id, e.amount as paid from ledger_transactions t
     join ledger_entries e on e.tx_id = t.id and e.account_id = $2
     where t.idempotency_key = $1 and t.kind = $3`,
    [req.key, wallet, kind],
  );
  const done = prior.rows[0];
  if (done) return { status: 'duplicate', txId: done.id, paid: done.paid, capped: false };
  const source = await systemAccount(tx, f.account as SystemAccount);
  const taken = await takenFrom(tx, wallet, source);
  const room = Math.max(0, Math.min(f.perHour - taken.hour, f.perDay - taken.day));
  const paid = Math.min(req.cents, room);
  if (paid <= 0) throw new FaucetCapped(f.about.toLowerCase());
  const result = await post(tx, {
    kind,
    key: req.key,
    actor: req.actor,
    memo: { ...req.memo, ...(paid < req.cents ? { asked: req.cents } : {}) },
    legs: [
      { account: source, amount: -paid },
      { account: wallet, amount: paid },
    ],
  });
  return { ...result, paid, capped: paid < req.cents };
}

/** Charges the player `cents` into `sink` (InsufficientFunds when they can't pay). */
export async function spend(
  tx: Tx,
  req: {
    accountId: string;
    sink: SinkName;
    cents: number;
    key: string;
    kind: string;
    memo?: Record<string, unknown>;
  },
): Promise<PostResult> {
  const s = SINKS[req.sink];
  // A charge is always money out of the wallet: a negative one would pay the player.
  if (!s) throw new LedgerError(`no sink ${req.sink}`);
  if (!Number.isSafeInteger(req.cents) || req.cents <= 0)
    throw new LedgerError(`bad charge ${req.cents}`);
  const wallet = await walletOf(tx, req.accountId);
  return post(tx, {
    kind: `spend:${req.kind}`,
    key: req.key,
    actor: `account:${req.accountId}`,
    memo: req.memo,
    legs: [
      { account: wallet, amount: -req.cents },
      { account: await systemAccount(tx, s.account), amount: req.cents },
    ],
  });
}
