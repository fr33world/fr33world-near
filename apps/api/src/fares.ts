/**
 * Fares the world server charges for services it runs (the taxi, shared TAXI; fuel and repairs
 * at the car parks, shared car-condition): a player's money into the purchases sink, keyed by
 * the world's id for it so a retry charges once. Only the kinds listed here, and never more
 * than MAX_FARE at a time.
 */
import type { SinkName } from '@fr33world/shared';
import { BankError } from './bank.ts';
import { type Db, inTx } from './db.ts';
import { spend } from './economy.ts';
import {
  AccountFrozen,
  balanceOf,
  EconomyPaused,
  InsufficientFunds,
  LedgerError,
  walletOf,
} from './ledger.ts';

/** The kinds of fare, and where each one's money goes. */
const KINDS: Record<string, SinkName> = {
  taxi: 'purchases',
  fuel: 'purchases',
  repair: 'purchases',
  hospital: 'fees',
};
/** $500: above the longest taxi ride and a full repair. */
const MAX_FARE = 50_000;

export async function chargeFare(
  db: Db,
  input: { account?: unknown; cents?: unknown; key?: unknown; kind?: unknown; to?: unknown },
): Promise<{ status: 'posted' | 'duplicate'; balance: number }> {
  const { account, cents, key, kind } = input;
  if (typeof account !== 'string') throw new BankError('account?');
  const sink = typeof kind === 'string' ? KINDS[kind] : undefined;
  if (typeof kind !== 'string' || !sink) throw new BankError('No such fare.');
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_FARE)
    throw new BankError('Bad fare.');
  if (typeof key !== 'string' || !/^[\w:-]{8,96}$/.test(key)) throw new BankError('Bad key.');
  const to = typeof input.to === 'string' ? input.to.slice(0, 60) : undefined;
  try {
    return await inTx(db, async (tx) => {
      const paid = await spend(tx, {
        accountId: account,
        sink,
        cents,
        key: `fare:${account}:${key}`,
        kind,
        memo: to ? { to } : undefined,
      });
      return { status: paid.status, balance: await balanceOf(tx, await walletOf(tx, account)) };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError) throw new BankError('The fare didn’t go through.', 409);
    throw e;
  }
}
