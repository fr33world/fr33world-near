/**
 * Admin corrections (technical-plan §7.8): there is no "set balance". Staff with the money
 * power put things right only with compensating ledger entries of kind 'correction' (which
 * go through even while the economy is paused): money added from the corrections faucet or
 * taken back into the corrections sink, with a reason; a past transaction reversed (its legs
 * mirrored, once); a wallet frozen or thawed. Every one goes to the staff audit log.
 */
import { randomUUID } from 'node:crypto';
import { type Db, inTx } from './db.ts';
import {
  balanceOf,
  InsufficientFunds,
  LedgerError,
  post,
  setFrozen,
  systemAccount,
  walletOf,
} from './ledger.ts';
import { accountOfName, actorCan, audit, StaffError } from './staff.ts';

const money = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US')}`;

async function allowed(db: Db, actor: string, supers: Set<string>) {
  if (!(await actorCan(db, actor, 'money', supers)))
    throw new StaffError("You can't correct money.", 403);
}

function reasonOf(input: unknown): string {
  const reason = typeof input === 'string' ? input.trim().slice(0, 200) : '';
  if (reason.length < 4) throw new StaffError('Say why (a reason is required).');
  return reason;
}

/** Adds (cents > 0) or takes back (cents < 0) money, with a reason. */
export async function correct(
  db: Db,
  actor: string,
  input: { name?: unknown; cents?: unknown; reason?: unknown },
  supers: Set<string>,
): Promise<{ name: string; cents: number; balance: number }> {
  await allowed(db, actor, supers);
  const cents = input.cents;
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents === 0)
    throw new StaffError('How much? e.g. 500 or -250.50');
  if (Math.abs(cents) > 100_000_000) throw new StaffError('At most $1,000,000 at a time.');
  const reason = reasonOf(input.reason);
  const target = await accountOfName(db, input.name);
  try {
    const balance = await inTx(db, async (tx) => {
      const wallet = await walletOf(tx, target.id);
      const other = await systemAccount(tx, cents > 0 ? 'faucet:corrections' : 'sink:corrections');
      await post(tx, {
        kind: 'correction',
        key: `correction:${randomUUID()}`,
        actor: `staff:${actor}`,
        memo: { reason, note: reason },
        legs: [
          { account: wallet, amount: cents },
          { account: other, amount: -cents },
        ],
      });
      return balanceOf(tx, wallet);
    });
    await audit(db, actor, 'money', target.name, `${money(cents)}: ${reason}`);
    return { name: target.name, cents, balance };
  } catch (e) {
    if (e instanceof InsufficientFunds)
      throw new StaffError(`${target.name} doesn't have that much to take back.`, 409);
    throw e;
  }
}

/** Undoes a past transaction by posting its mirror (once per transaction). */
export async function reverse(
  db: Db,
  actor: string,
  input: { tx?: unknown; reason?: unknown },
  supers: Set<string>,
): Promise<{ tx: number; kind: string; legs: number }> {
  await allowed(db, actor, supers);
  const id = Number(input.tx);
  if (!Number.isSafeInteger(id) || id <= 0) throw new StaffError('Which transaction? (its number)');
  const reason = reasonOf(input.reason);
  const found = await db.query<{ kind: string; account_id: number; amount: number }>(
    `select t.kind, e.account_id, e.amount from ledger_transactions t
     join ledger_entries e on e.tx_id = t.id where t.id = $1`,
    [id],
  );
  const first = found.rows[0];
  if (!first) throw new StaffError(`No transaction ${id}.`, 404);
  try {
    const r = await inTx(db, (tx) =>
      post(tx, {
        kind: 'correction',
        key: `reverse:${id}`,
        actor: `staff:${actor}`,
        memo: { reverses: id, reason, note: `Reversed: ${reason}` },
        legs: found.rows.map((e) => ({ account: e.account_id, amount: -e.amount })),
      }),
    );
    if (r.status === 'duplicate')
      throw new StaffError(`Transaction ${id} was already reversed.`, 409);
  } catch (e) {
    if (e instanceof InsufficientFunds)
      throw new StaffError(
        'Someone in it has spent the money: freeze them and take back what is left.',
        409,
      );
    if (e instanceof LedgerError)
      throw new StaffError(`Transaction ${id} was already reversed.`, 409);
    throw e;
  }
  await audit(db, actor, 'reverse', `tx ${id}`, `${first.kind}: ${reason}`);
  return { tx: id, kind: first.kind, legs: found.rows.length };
}

/** Freezes (or thaws) a player's wallet: they can be paid, but nothing leaves it. */
export async function freeze(
  db: Db,
  actor: string,
  input: { name?: unknown; frozen?: unknown; reason?: unknown },
  supers: Set<string>,
): Promise<{ name: string; frozen: boolean }> {
  await allowed(db, actor, supers);
  const target = await accountOfName(db, input.name);
  const frozen = input.frozen !== false;
  await setFrozen(db, await walletOf(db, target.id), frozen);
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 200) : '';
  await audit(db, actor, frozen ? 'freeze' : 'thaw', target.name, reason);
  return { name: target.name, frozen };
}

/** A player's balance and whether their wallet is frozen. */
export async function lookUp(
  db: Db,
  actor: string,
  input: { name?: unknown },
  supers: Set<string>,
): Promise<{ name: string; balance: number; frozen: boolean }> {
  await allowed(db, actor, supers);
  const target = await accountOfName(db, input.name);
  const wallet = await walletOf(db, target.id);
  const r = await db.query<{ frozen: boolean }>(
    'select frozen from ledger_accounts where id = $1',
    [wallet],
  );
  return { name: target.name, balance: await balanceOf(db, wallet), frozen: !!r.rows[0]?.frozen };
}
