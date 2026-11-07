/**
 * The `$` ledger (migrations/001): every change of money is one balanced transaction of two or
 * more legs, posted inside the caller's database transaction so it commits or fails together
 * with whatever it pays for (a car changing hands, a job completing).
 *
 * Amounts are integer cents. The database enforces balance, no overdraft and append-only
 * history; this module adds early validation, idempotency handling and readable errors.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { type Db, inTx, type Tx } from './db.ts';

export interface Leg {
  /** ledger_accounts.id */
  account: number;
  /** Cents; positive credits the account, negative debits it. */
  amount: number;
}

export interface Posting {
  /** What happened: 'signup_bonus', 'salary', 'car_purchase', 'trade', ... */
  kind: string;
  /** Unique per real-world event; a retry with the same key posts nothing. */
  key: string;
  legs: Leg[];
  memo?: Record<string, unknown>;
  /** Who caused it: 'system' (default), 'account:<id>', 'staff:<id>'. */
  actor?: string;
}

export type PostResult = { status: 'posted' | 'duplicate'; txId: number };

/** When the ledger last posted (ms), for the invariant monitor (monitor.ts). */
export const ledgerActivity = { lastPostAt: 0 };

/** Largest single amount accepted: $10 billion. Anything near it is a bug or an exploit. */
const MAX_AMOUNT = 1_000_000_000_000;

export class LedgerError extends Error {}
export class InsufficientFunds extends LedgerError {
  constructor() {
    super('Not enough money');
  }
}
export class EconomyPaused extends LedgerError {
  constructor() {
    super('The economy is paused for a check. Try again a little later.');
  }
}
export class AccountFrozen extends LedgerError {
  constructor() {
    super('This wallet is frozen while it is reviewed');
  }
}

export type SystemAccount =
  | 'faucet:signup'
  | 'faucet:salary'
  | 'faucet:jobs'
  | 'faucet:corrections'
  | 'faucet:tutorial'
  | 'faucet:daily'
  | 'sink:fees'
  | 'sink:purchases'
  | 'sink:corrections';

/** Deterministic JSON (sorted keys), for fingerprints. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** What a posting asks for, as a fingerprint: the same key must always ask the same. */
export function requestHash(p: Posting): string {
  const legs = [...p.legs].sort((a, b) => a.account - b.account);
  return createHash('sha256')
    .update(canonical({ kind: p.kind, legs, memo: p.memo ?? {} }))
    .digest('hex');
}

export async function post(tx: Tx, p: Posting): Promise<PostResult> {
  validate(p);
  const hash = requestHash(p);
  const inserted = await tx
    .query<{ id: number }>(
      `insert into ledger_transactions (kind, idempotency_key, memo, request_hash, actor)
       values ($1, $2, $3, $4, $5)
       on conflict (idempotency_key) do nothing returning id`,
      [p.kind, p.key, p.memo ?? {}, hash, p.actor ?? 'system'],
    )
    .catch((e: unknown) => {
      throw translate(e);
    });
  const row = inserted.rows[0];
  if (!row) {
    const prior = await tx.query<{ id: number; kind: string; request_hash: string | null }>(
      'select id, kind, request_hash from ledger_transactions where idempotency_key = $1',
      [p.key],
    );
    const first = prior.rows[0];
    // A replay must ask exactly what the first asked (rows from before 008 have no hash).
    if (!first || first.kind !== p.kind || (first.request_hash ?? hash) !== hash) {
      throw new LedgerError(`idempotency key ${p.key} was used for a different transaction`);
    }
    return { status: 'duplicate', txId: first.id };
  }
  // Same lock order for every transaction (ascending account id), so two transfers between
  // the same accounts can't deadlock.
  const legs = [...p.legs].sort((a, b) => a.account - b.account);
  try {
    for (const leg of legs) {
      await tx.query('insert into ledger_entries (tx_id, account_id, amount) values ($1, $2, $3)', [
        row.id,
        leg.account,
        leg.amount,
      ]);
    }
  } catch (e) {
    throw translate(e);
  }
  ledgerActivity.lastPostAt = Date.now();
  return { status: 'posted', txId: row.id };
}

/** post() in its own database transaction. */
export async function transfer(db: Db, p: Posting): Promise<PostResult> {
  try {
    return await inTx(db, (tx) => post(tx, p));
  } catch (e) {
    throw translate(e);
  }
}

function validate(p: Posting) {
  if (!p.key || p.key.length > 200) throw new LedgerError('bad idempotency key');
  if (p.legs.length < 2) throw new LedgerError('a transaction needs at least two legs');
  let sum = 0;
  const seen = new Set<number>();
  for (const leg of p.legs) {
    if (
      !Number.isSafeInteger(leg.amount) ||
      leg.amount === 0 ||
      Math.abs(leg.amount) > MAX_AMOUNT
    ) {
      throw new LedgerError(`bad amount ${leg.amount}`);
    }
    if (seen.has(leg.account)) throw new LedgerError('one leg per account');
    seen.add(leg.account);
    sum += leg.amount;
  }
  if (sum !== 0) throw new LedgerError(`legs don't balance (off by ${sum})`);
}

function translate(e: unknown): unknown {
  const err = e as pg.DatabaseError;
  if (err?.code === '23514' && err.constraint === 'no_overdraft') return new InsufficientFunds();
  if (err?.code === '23514' && err.constraint === 'account_frozen') return new AccountFrozen();
  if (err?.code === '23514' && err.constraint === 'economy_paused') return new EconomyPaused();
  return e;
}

/** The player's `$` account, created on first use. */
export async function walletOf(tx: Tx | Db, accountId: string): Promise<number> {
  const found = await tx.query<{ id: number }>(
    `insert into ledger_accounts (kind, owner_id) values ('player', $1)
     on conflict (owner_id) where kind = 'player' do nothing returning id`,
    [accountId],
  );
  if (found.rows[0]) return found.rows[0].id;
  const existing = await tx.query<{ id: number }>(
    "select id from ledger_accounts where owner_id = $1 and kind = 'player'",
    [accountId],
  );
  return (existing.rows[0] as { id: number }).id;
}

/** Freezes a wallet (it can be paid, but nothing leaves it) or thaws it. */
export async function setFrozen(
  tx: Tx | Db,
  ledgerAccount: number,
  frozen: boolean,
): Promise<void> {
  await tx.query('update ledger_accounts set frozen = $2 where id = $1', [ledgerAccount, frozen]);
}

export async function systemAccount(tx: Tx | Db, code: SystemAccount): Promise<number> {
  const r = await tx.query<{ id: number }>('select id from ledger_accounts where code = $1', [
    code,
  ]);
  const row = r.rows[0];
  if (!row) throw new LedgerError(`missing system account ${code}`);
  return row.id;
}

export async function balanceOf(tx: Tx | Db, ledgerAccount: number): Promise<number> {
  const r = await tx.query<{ balance: number }>(
    'select balance from ledger_accounts where id = $1',
    [ledgerAccount],
  );
  return r.rows[0]?.balance ?? 0;
}

export interface Audit {
  /** Sum of every balance: always 0 in a closed loop. */
  total: number;
  /** Money in players' hands and escrow (what the faucets have paid in, minus sinks). */
  circulating: number;
  /** Accounts whose stored balance differs from the sum of their entries (must be none). */
  drifted: number;
  /** Transactions that don't sum to zero (must be none). */
  unbalanced: number;
}

/** The invariant monitor (D-24): cheap enough to run every few minutes in production. */
export async function audit(db: Db): Promise<Audit> {
  const totals = await db.query<{ total: number; circulating: number }>(
    `select coalesce(sum(balance), 0)::bigint as total,
            coalesce(sum(balance) filter (where kind in ('player', 'escrow')), 0)::bigint as circulating
     from ledger_accounts`,
  );
  const drifted = await db.query<{ n: number }>(
    `select count(*)::bigint as n from ledger_accounts a
     where a.balance <> coalesce((select sum(amount) from ledger_entries e where e.account_id = a.id), 0)`,
  );
  const unbalanced = await db.query<{ n: number }>(
    `select count(*)::bigint as n from (
       select tx_id from ledger_entries group by tx_id having sum(amount) <> 0) t`,
  );
  const t = totals.rows[0] as { total: number; circulating: number };
  return {
    total: t.total,
    circulating: t.circulating,
    drifted: (drifted.rows[0] as { n: number }).n,
    unbalanced: (unbalanced.rows[0] as { n: number }).n,
  };
}
