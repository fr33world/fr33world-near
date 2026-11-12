/**
 * Player accounts. The first login creates the account and its `$` wallet; onboarding asks
 * the date of birth (18+, once) and the Terms acceptance; then the sign-up bonus is paid once
 * (its idempotency key is the account id, so even a crash between steps can't pay it twice).
 */
import {
  ageOn,
  CHARACTER_AGE,
  checkCharacterName,
  isAppearance,
  isBirthDate,
  isGear,
  MIN_AGE,
  encodeAppearance,
  encodeGear,
  FAUCETS,
  handleFor,
  TERMS_VERSION,
} from '@fr33world/shared';
import { type Db, inTx, type Tx } from './db.ts';
import { balanceOf, post, systemAccount, walletOf } from './ledger.ts';

export interface Account {
  id: string;
  name: string;
  guest: boolean;
}

/** The player's character, once made. */
export interface Character {
  name: string;
  age: number;
  /** Shared `encodeAppearance` code. */
  look: number;
  /** Shared `encodeGear` code. */
  gear: number;
  /** Experience (shared `levelOf`). */
  xp: number;
  /** Where the tutorial is (shared TUTORIAL_STEPS, 'done' or 'skipped'). */
  tutorial: string;
}

/** What a player must still do before they may enter the city. */
export type Need = 'age' | 'terms' | 'character';

export interface Session {
  account: Account;
  /** `$` balance in cents. */
  balance: number;
  created: boolean;
  needs: Need[];
  /** Set when the account may never play (e.g. 'under_18'). */
  blocked: string | null;
  character: Character | null;
}

export class OnboardingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface AccountRow {
  id: string;
  display_name: string;
  is_guest: boolean;
  birth_date: string | null;
  blocked_reason: string | null;
  terms_version: string | null;
  character_name: string | null;
  character_age: number | null;
  character_look: number | null;
  character_gear: number | null;
  character_xp: number | null;
  character_tutorial: string | null;
}

export const SIGNUP_BONUS_CENTS = Number(
  process.env.SIGNUP_BONUS_CENTS ?? FAUCETS.signup.maxPayment,
);

/** Printable, trimmed, 1–24 characters; a generated name otherwise. */
export function cleanName(raw: unknown, fallbackSeed: string): string {
  const text = typeof raw === 'string' ? raw : '';
  const printable = [...text]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f && !(c >= 0x200b && c <= 0x200f);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  if (printable) return printable;
  return handleFor(fallbackSeed);
}

const ACCOUNT_COLUMNS = `id, display_name, is_guest, to_char(birth_date, 'YYYY-MM-DD') as birth_date,
  blocked_reason, terms_version,
  (select name from characters c where c.account_id = accounts.id) as character_name,
  (select age from characters c where c.account_id = accounts.id) as character_age,
  (select appearance from characters c where c.account_id = accounts.id) as character_look,
  (select gear from characters c where c.account_id = accounts.id) as character_gear,
  (select xp from characters c where c.account_id = accounts.id) as character_xp,
  (select tutorial from characters c where c.account_id = accounts.id) as character_tutorial`;

function needsOf(row: AccountRow): Need[] {
  const needs: Need[] = [];
  if (!row.birth_date) needs.push('age');
  if (row.terms_version !== TERMS_VERSION) needs.push('terms');
  if (row.character_name === null) needs.push('character');
  return needs;
}

/**
 * Loads (or on first login creates) the account. The sign-up bonus is paid once onboarding
 * is complete, so a blocked account never receives money. `guest` is Privy's word on it (null
 * when Privy couldn't be asked: the account keeps what it was); a guest who has linked an
 * account since becomes a full account.
 */
export async function openSession(
  db: Db,
  privyUserId: string,
  requestedName: unknown,
  guest: boolean | null = false,
): Promise<Session> {
  return inTx(db, async (tx) => {
    const r = await tx.query<AccountRow & { created: boolean }>(
      `insert into accounts (privy_user_id, display_name, is_guest)
       values ($1, $2, coalesce($3, false))
       on conflict (privy_user_id) do update
         set last_seen_at = now(), is_guest = coalesce($3, accounts.is_guest)
       returning ${ACCOUNT_COLUMNS}, (xmax = 0) as created`,
      [privyUserId, cleanName(requestedName, privyUserId), guest],
    );
    const row = r.rows[0] as AccountRow & { created: boolean };
    return { ...(await settle(tx, row)), created: row.created };
  });
}

/**
 * Records the date of birth (once, ever) and the Terms acceptance. Under 18 blocks the
 * account for good. `today` is the server's UTC date.
 */
export async function completeOnboarding(
  db: Db,
  privyUserId: string,
  answers: { birthDate?: unknown; termsVersion?: unknown },
  today = new Date().toISOString().slice(0, 10),
): Promise<Session> {
  return inTx(db, async (tx) => {
    const r = await tx.query<AccountRow>(
      `select ${ACCOUNT_COLUMNS} from accounts where privy_user_id = $1 for update`,
      [privyUserId],
    );
    const found = r.rows[0];
    if (!found) throw new OnboardingError('No account yet. Log in first.', 404);
    let row: AccountRow = found;
    if (row.blocked_reason) throw new OnboardingError('This account cannot play.', 403);

    if (answers.birthDate !== undefined && answers.birthDate !== row.birth_date) {
      if (row.birth_date) throw new OnboardingError('Your date of birth is already set.', 409);
      if (!isBirthDate(answers.birthDate, today))
        throw new OnboardingError('Enter a real date of birth.');
      const underage = ageOn(answers.birthDate, today) < MIN_AGE;
      const u = await tx.query<AccountRow>(
        `update accounts set birth_date = $2, age_checked_at = now(),
           blocked_reason = case when $3 then 'under_18' end,
           blocked_at = case when $3 then now() end
         where id = $1 returning ${ACCOUNT_COLUMNS}`,
        [row.id, answers.birthDate, underage],
      );
      row = u.rows[0] as AccountRow;
    }
    if (answers.termsVersion !== undefined && !row.blocked_reason) {
      if (answers.termsVersion !== TERMS_VERSION) {
        throw new OnboardingError('Please accept the current Terms and Privacy Policy.');
      }
      const u = await tx.query<AccountRow>(
        `update accounts set terms_version = $2, terms_accepted_at = now()
         where id = $1 returning ${ACCOUNT_COLUMNS}`,
        [row.id, TERMS_VERSION],
      );
      row = u.rows[0] as AccountRow;
    }
    return { ...(await settle(tx, row)), created: false };
  });
}

/** Balance, outstanding needs, and the sign-up bonus once nothing is outstanding. */
async function settle(tx: Tx, row: AccountRow): Promise<Omit<Session, 'created'>> {
  const wallet = await walletOf(tx, row.id);
  const needs = row.blocked_reason ? [] : needsOf(row);
  // Not while the economy is paused (monitor.ts): the next login pays it (it's keyed once).
  const paused = await tx.query('select 1 from economy_control where paused_at is not null');
  if (!row.blocked_reason && needs.length === 0 && SIGNUP_BONUS_CENTS > 0 && !paused.rowCount) {
    await post(tx, {
      kind: 'signup_bonus',
      key: `signup:${row.id}`,
      legs: [
        { account: await systemAccount(tx, 'faucet:signup'), amount: -SIGNUP_BONUS_CENTS },
        { account: wallet, amount: SIGNUP_BONUS_CENTS },
      ],
    });
  }
  return {
    account: { id: row.id, name: row.display_name, guest: row.is_guest },
    balance: await balanceOf(tx, wallet),
    needs,
    blocked: row.blocked_reason,
    character:
      row.character_name === null
        ? null
        : {
            name: row.character_name,
            age: row.character_age ?? CHARACTER_AGE.min,
            look: row.character_look ?? 0,
            gear: row.character_gear ?? 0,
            xp: row.character_xp ?? 0,
            tutorial: row.character_tutorial ?? 'welcome',
          },
  };
}

/** Whether a character name is free (and how it would be written), or why it can't be. */
export async function checkName(
  db: Db,
  raw: unknown,
): Promise<{ name: string; available: boolean } | { error: string }> {
  const checked = checkCharacterName(raw);
  if ('error' in checked) return checked;
  const r = await db.query('select 1 from characters where lower(name) = lower($1)', [
    checked.name,
  ]);
  return { name: checked.name, available: r.rowCount === 0 };
}

/**
 * Makes the account's character (once): a free role-play name, an age of 18–80, a valid
 * appearance and (optionally) gear. Only after the age gate and the Terms.
 */
export async function createCharacter(
  db: Db,
  privyUserId: string,
  input: { name?: unknown; age?: unknown; appearance?: unknown; gear?: unknown },
): Promise<Session> {
  const checked = checkCharacterName(input.name);
  if ('error' in checked) throw new OnboardingError(checked.error);
  const age = input.age;
  if (
    typeof age !== 'number' ||
    !Number.isInteger(age) ||
    age < CHARACTER_AGE.min ||
    age > CHARACTER_AGE.max
  )
    throw new OnboardingError(`Age is ${CHARACTER_AGE.min} to ${CHARACTER_AGE.max}.`);
  if (!isAppearance(input.appearance))
    throw new OnboardingError('That appearance is not available.');
  const look = encodeAppearance(input.appearance);
  if (input.gear !== undefined && !isGear(input.gear))
    throw new OnboardingError('Those accessories are not available.');
  const gear = input.gear === undefined ? 0 : encodeGear(input.gear);
  return inTx(db, async (tx) => {
    const r = await tx.query<AccountRow>(
      `select ${ACCOUNT_COLUMNS} from accounts where privy_user_id = $1 for update`,
      [privyUserId],
    );
    const row = r.rows[0];
    if (!row) throw new OnboardingError('No account yet. Log in first.', 404);
    if (row.blocked_reason) throw new OnboardingError('This account cannot play.', 403);
    if (needsOf(row).some((n) => n !== 'character'))
      throw new OnboardingError('Confirm your age and the Terms first.', 409);
    if (row.character_name !== null)
      throw new OnboardingError('You already have a character.', 409);
    const taken = await tx.query('select 1 from characters where lower(name) = lower($1)', [
      checked.name,
    ]);
    if ((taken.rowCount ?? 0) > 0) throw new OnboardingError('That name is taken.', 409);
    try {
      await tx.query(
        'insert into characters (account_id, name, age, appearance, gear) values ($1, $2, $3, $4, $5)',
        [row.id, checked.name, age, look, gear],
      );
    } catch (e) {
      // Two players racing for one name: the unique index decides.
      if ((e as { code?: string }).code === '23505')
        throw new OnboardingError('That name is taken.', 409);
      throw e;
    }
    const u = await tx.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from accounts where id = $1`, [
      row.id,
    ]);
    return { ...(await settle(tx, u.rows[0] as AccountRow)), created: false };
  });
}
