/**
 * The bank behind the in-game phone: a player's balance and history, and payments to other
 * players by character name (technical-plan §7.4: the only player-entered amounts, so bounded,
 * rate-limited and logged; shared PAYMENTS). A payment is one ledger transaction from wallet to
 * wallet, keyed by the sender's own request id, so a retry pays once.
 */
import { PAYMENTS } from '@fr33world/shared';
import { type Db, inTx } from './db.ts';
import {
  AccountFrozen,
  balanceOf,
  EconomyPaused,
  InsufficientFunds,
  LedgerError,
  post,
  walletOf,
} from './ledger.ts';

export class BankError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const PAGE = 30;

export interface HistoryItem {
  id: number;
  at: string;
  /** The ledger's kind: 'signup_bonus', 'earn:jobs', 'payment', 'spend:hospital', ... */
  kind: string;
  /** Cents in (positive) or out (negative) of this wallet. */
  amount: number;
  /** The other player, for payments. */
  other: string | null;
  note: string | null;
}

interface Me {
  id: string;
  guest: boolean;
  character: string | null;
  characterAgeHours: number;
}

async function me(db: Db, privyUser: string): Promise<Me> {
  const r = await db.query<{
    id: string;
    is_guest: boolean;
    name: string | null;
    age_hours: number | null;
  }>(
    `select a.id, a.is_guest, c.name,
            extract(epoch from now() - c.created_at) / 3600 as age_hours
     from accounts a left join characters c on c.account_id = a.id
     where a.privy_user_id = $1`,
    [privyUser],
  );
  const row = r.rows[0];
  if (!row) throw new BankError('Please log in again.', 401);
  return {
    id: row.id,
    guest: row.is_guest,
    character: row.name,
    characterAgeHours: Number(row.age_hours ?? 0),
  };
}

/** Balance, whether the wallet is frozen, and a page of history (older than `before`). */
export async function statement(db: Db, privyUser: string, before?: number) {
  const { id } = await me(db, privyUser);
  const wallet = await walletOf(db, id);
  const frozen = await db.query<{ frozen: boolean }>(
    'select frozen from ledger_accounts where id = $1',
    [wallet],
  );
  const rows = await db.query<HistoryItem>(
    `select t.id, t.created_at as at, t.kind, e.amount,
            (select c.name from ledger_entries o
               join ledger_accounts oa on oa.id = o.account_id and oa.kind = 'player'
               join characters c on c.account_id = oa.owner_id
             where o.tx_id = t.id and o.account_id <> e.account_id limit 1) as other,
            t.memo ->> 'note' as note
     from ledger_entries e join ledger_transactions t on t.id = e.tx_id
     where e.account_id = $1 and ($2::bigint is null or t.id < $2)
     order by t.id desc limit $3`,
    [wallet, Number.isSafeInteger(before) ? before : null, PAGE + 1],
  );
  return {
    balance: await balanceOf(db, wallet),
    frozen: !!frozen.rows[0]?.frozen,
    history: rows.rows.slice(0, PAGE),
    more: rows.rows.length > PAGE,
  };
}

/** Tidies a note: one line, printable, short. */
function cleanNote(note: unknown): string {
  if (typeof note !== 'string') return '';
  return [...note.replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim()]
    .slice(0, PAYMENTS.noteChars)
    .join('');
}

/** Sends `cents` to the character named `to`. `key` is the client's id for this send. */
export async function pay(
  db: Db,
  privyUser: string,
  input: { to?: unknown; cents?: unknown; note?: unknown; key?: unknown },
): Promise<{ status: 'posted' | 'duplicate'; balance: number; to: string }> {
  const sender = await me(db, privyUser);
  if (!sender.character) throw new BankError('Make your character first.', 403);
  if (sender.guest)
    throw new BankError(
      'Guest accounts can’t send money. Link an email or social login first.',
      403,
    );
  if (sender.characterAgeHours < PAYMENTS.minCharacterAgeHours)
    throw new BankError(
      `New characters can send money after ${PAYMENTS.minCharacterAgeHours} hours in the city.`,
      403,
    );
  const cents = input.cents;
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents < PAYMENTS.min)
    throw new BankError(`Send at least $${PAYMENTS.min / 100}.`);
  if (cents > PAYMENTS.max)
    throw new BankError(`At most $${(PAYMENTS.max / 100).toLocaleString('en-US')} at a time.`);
  if (typeof input.key !== 'string' || !/^[\w-]{8,64}$/.test(input.key))
    throw new BankError('Bad request id.');
  if (typeof input.to !== 'string' || !input.to.trim()) throw new BankError('Who to?');
  const found = await db.query<{ id: string; name: string }>(
    'select account_id as id, name from characters where lower(name) = lower($1)',
    [input.to.trim()],
  );
  const recipient = found.rows[0];
  if (!recipient) throw new BankError(`Nobody in the city is called ${input.to.trim()}.`, 404);
  if (recipient.id === sender.id) throw new BankError('That’s you.');
  const note = cleanNote(input.note);
  const key = `pay:${sender.id}:${input.key}`;

  try {
    return await inTx(db, async (tx) => {
      const from = await walletOf(tx, sender.id);
      const to = await walletOf(tx, recipient.id);
      // One send per wallet at a time, so the limits below can't be raced.
      await tx.query('select id from ledger_accounts where id = $1 for update', [from]);
      const done = await tx.query('select 1 from ledger_transactions where idempotency_key = $1', [
        key,
      ]);
      if (!done.rowCount) {
        const sent = await tx.query<{ hour: number; day: number }>(
          `select count(*) filter (where e.created_at > now() - interval '1 hour')::int as hour,
                  coalesce(sum(-e.amount), 0)::bigint as day
           from ledger_entries e join ledger_transactions t on t.id = e.tx_id
           where e.account_id = $1 and t.kind = 'payment' and e.amount < 0
             and e.created_at > now() - interval '1 day'`,
          [from],
        );
        const { hour = 0, day = 0 } = sent.rows[0] ?? {};
        if (hour >= PAYMENTS.perHour)
          throw new BankError('That’s a lot of payments. Try again in a while.', 429);
        if (day + cents > PAYMENTS.perDay)
          throw new BankError('That’s more than you can send today.', 429);
      }
      const result = await post(tx, {
        kind: 'payment',
        key,
        actor: `account:${sender.id}`,
        memo: { to: recipient.name, ...(note ? { note } : {}) },
        legs: [
          { account: from, amount: -cents },
          { account: to, amount: cents },
        ],
      });
      return {
        status: result.status,
        balance: await balanceOf(tx, from),
        to: recipient.name,
      };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError) throw new BankError('That payment didn’t go through.', 409);
    throw e;
  }
}
