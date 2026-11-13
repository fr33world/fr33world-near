/**
 * Homes as assets on NEAR (owner, 2026-11-13; shared HOMES and HOME_ASSETS). Each hill villa is
 * bought for `$` at its door, by one player, and its title deed is minted to the buyer's own
 * NEAR wallet on the homes contract (contracts/cars' code under its own name). From then on the
 * chain says who owns it and the game follows: a home sent on chain becomes the home of the
 * player whose wallet holds it, or nobody's while an unlinked wallet holds it.
 *
 * Only full accounts may buy a home, so every home has a deed: a guest has no wallet to hold it.
 */
import { HOME_ASSETS, HOMES, homePrice, homeTitle } from '@fr33world/shared';
import { BankError } from './bank.ts';
import { type Db, inTx, type Tx } from './db.ts';
import { spend } from './economy.ts';
import {
  AccountFrozen,
  balanceOf,
  EconomyPaused,
  InsufficientFunds,
  LedgerError,
  walletOf,
} from './ledger.ts';

/** A home on the homes contract, as `nft_token` returns it. */
export interface ChainHome {
  token_id: string;
  owner_id: string;
}

/** What this module needs of NEAR (packages/chain NearEconomy), so tests can stand in. */
export interface HomeChain {
  homesAccount(): string;
  /** A home's title deed on the block explorer. */
  homeDeedUrl?(tokenId: string): string;
  mintHome(
    tokenId: string,
    owner: string,
    metadata: { title: string; description: string; media: string | null; extra: string },
  ): Promise<{ tx: string }>;
  homeToken(tokenId: string): Promise<ChainHome | null>;
  homeTokens(from: number, limit: number): Promise<ChainHome[]>;
}

export interface HomeDeps {
  db: Db;
  chain: HomeChain;
  /** Links the player's Privy NEAR wallet if it isn't yet (usdc.ts linkWallet). */
  link: (privyUser: string) => Promise<{ near: string }>;
  /** Between looks for a mint's effect on chain (ms). */
  confirmGapMs?: number;
}

/** A home as the game shows it: every villa, bought or not. */
export interface Home {
  villa: number;
  address: string;
  /** Its price in cents. */
  price: number;
  /** The owner's character name, or null while it's for sale (or away from the game). */
  owner: string | null;
  mine: boolean;
  /** Its title deed once it has one: the token, whether it's on chain yet, and a link. */
  deed: { token: string; minted: boolean; url: string | null } | null;
}

// ---- Looking -------------------------------------------------------------------------------

/** Every villa: price, owner and deed. `me` is the asking account (or null). */
export async function homesView(
  db: Db | Tx,
  me: string | null,
  deedUrl?: (token: string) => string,
): Promise<Home[]> {
  const r = await db.query<{
    villa: number;
    account_id: string;
    away: boolean;
    name: string | null;
    asset: string | null;
    status: string | null;
  }>(
    `select h.villa, h.account_id, h.away, c.name, k.asset, k.status
     from owned_homes h left join characters c on c.account_id = h.account_id
     left join home_chain k on k.villa = h.villa`,
  );
  const owned = new Map(r.rows.map((x) => [Number(x.villa), x]));
  return HOMES.map(([address], villa) => {
    const o = owned.get(villa);
    const minted = o?.status === 'done';
    return {
      villa,
      address,
      price: homePrice(villa) as number,
      owner: o && !o.away ? (o.name ?? 'Someone') : o ? 'Someone' : null,
      mine: !!o && !o.away && o.account_id === me,
      deed: o?.asset
        ? { token: o.asset, minted, url: minted && deedUrl ? deedUrl(o.asset) : null }
        : null,
    };
  });
}

// ---- Buying --------------------------------------------------------------------------------

/**
 * Buys a villa for `$`, keyed by the player's request id so a retry pays once. The deed is
 * queued for the buyer's wallet; the caller links the wallet and mints (app.ts homesSoon).
 */
export async function buyHome(
  db: Db,
  privyUser: string,
  input: { villa?: unknown; key?: unknown },
  deedUrl?: (token: string) => string,
): Promise<{ home: Home; balance: number }> {
  const villa = input.villa;
  const price = typeof villa === 'number' && Number.isInteger(villa) ? homePrice(villa) : null;
  if (price === null || typeof villa !== 'number') throw new BankError('That home isn’t for sale.');
  if (typeof input.key !== 'string' || !/^[\w-]{8,64}$/.test(input.key))
    throw new BankError('Bad request id.');
  const r = await db.query<{
    id: string;
    blocked: string | null;
    character: string | null;
    guest: boolean;
  }>(
    `select a.id, a.blocked_reason as blocked, c.name as character, a.is_guest as guest
     from accounts a left join characters c on c.account_id = a.id
     where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me || me.blocked) throw new BankError('Please log in again.', 401);
  if (!me.character) throw new BankError('Make your character first.', 403);
  if (me.guest)
    throw new BankError(
      'A home is minted to your own NEAR wallet: link an email or social login first.',
      403,
    );
  const key = `home:${me.id}:${input.key}`;

  try {
    return await inTx(db, async (tx) => {
      const wallet = await walletOf(tx, me.id);
      // One purchase per wallet at a time, so the limit can't be raced.
      await tx.query('select id from ledger_accounts where id = $1 for update', [wallet]);
      const was = await tx.query<{ account_id: string; key: string | null }>(
        `select h.account_id, t.idempotency_key as key from owned_homes h
         join ledger_transactions t on t.id = h.purchase_tx where h.villa = $1`,
        [villa],
      );
      const held = was.rows[0];
      // Asking again after a lost answer: it's already this player's, by this purchase.
      if (held?.key === key)
        return {
          home: (await homesView(tx, me.id, deedUrl))[villa] as Home,
          balance: await balanceOf(tx, wallet),
        };
      if (held) throw new BankError('Someone already owns this home.', 409);
      const mine = await tx.query<{ n: number }>(
        'select count(*)::int as n from owned_homes where account_id = $1 and not away',
        [me.id],
      );
      if ((mine.rows[0]?.n ?? 0) >= HOME_ASSETS.perPlayer)
        throw new BankError(`You can own ${HOME_ASSETS.perPlayer} homes at most.`, 409);
      const paid = await spend(tx, {
        accountId: me.id,
        sink: 'purchases',
        cents: price,
        key,
        kind: 'home',
        memo: { villa, address: HOMES[villa]?.[0] },
      });
      await tx.query(
        'insert into owned_homes (villa, account_id, purchase_tx) values ($1, $2, $3)',
        [villa, me.id, paid.txId],
      );
      await queueHomeMints(tx, me.id);
      return {
        home: (await homesView(tx, me.id, deedUrl))[villa] as Home,
        balance: await balanceOf(tx, wallet),
      };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new BankError('Not enough money.', 402);
    if (e instanceof AccountFrozen) throw new BankError(e.message, 403);
    if (e instanceof EconomyPaused) throw new BankError(e.message, 503);
    if (e instanceof LedgerError) throw new BankError('That purchase didn’t go through.', 409);
    // Two buyers at once: the second insert loses, and its charge rolls back with it.
    if ((e as { code?: string }).code === '23505')
      throw new BankError('Someone just bought this home.', 409);
    throw e;
  }
}

// ---- Minting -------------------------------------------------------------------------------

/** Queues a title deed for each of the player's homes that hasn't one, once they have a wallet. */
export async function queueHomeMints(db: Db | Tx, accountId: string): Promise<number> {
  const r = await db.query(
    `insert into home_chain (villa, status, wallet, asset)
     select h.villa, 'mint', w.near_account,
       'home-' || h.villa || '-' || substr(md5(random()::text), 1, 6)
     from owned_homes h join near_wallets w on w.account_id = h.account_id
     where h.account_id = $1 and not h.away
     on conflict (villa) do nothing`,
    [accountId],
  );
  return r.rowCount ?? 0;
}

/** What a home's title deed says in any NEAR wallet. */
export function homeDeed(villa: number) {
  const address = HOMES[villa]?.[0] ?? `Villa ${villa}`;
  return {
    title: homeTitle(villa),
    description: `A villa at ${address}, in the hills above the city of fr33world, the city game in the browser. Whoever holds this owns the home in the game.`,
    media: `${HOME_ASSETS.mediaBase}villa-${villa}.webp`,
    extra: JSON.stringify({ game: 'fr33world', home: villa, address }),
  };
}

function backoff(attempts: number): number {
  return Math.min(6 * 3600, 30 * 2 ** attempts);
}

/** Mints queued title deeds. Asks the chain first, so a retry never mints twice. */
export async function runHomeMints(d: HomeDeps): Promise<number> {
  const due = await d.db.query<{ villa: number; wallet: string; asset: string; attempts: number }>(
    `select villa, wallet, asset, attempts from home_chain
     where status = 'mint' and next_at <= now() order by next_at limit 10`,
  );
  let done = 0;
  for (const m of due.rows) {
    try {
      let t = await d.chain.homeToken(m.asset);
      if (!t) {
        await d.chain.mintHome(m.asset, m.wallet, homeDeed(Number(m.villa)));
        for (let i = 0; i < 6 && !t; i += 1) {
          if (i > 0) await new Promise((r) => setTimeout(r, d.confirmGapMs ?? 1000));
          t = await d.chain.homeToken(m.asset);
        }
      }
      if (!t) throw new Error('not on chain after minting');
      await d.db.query(
        `update home_chain set status = 'done', wallet = $2, last_error = null, updated_at = now()
         where villa = $1`,
        [m.villa, t.owner_id],
      );
      done += 1;
    } catch (e) {
      await d.db.query(
        `update home_chain set attempts = attempts + 1, last_error = $2, updated_at = now(),
           next_at = now() + make_interval(secs => $3) where villa = $1`,
        [m.villa, (e instanceof Error ? e.message : String(e)).slice(0, 300), backoff(m.attempts)],
      );
    }
  }
  return done;
}

// ---- Following the chain -------------------------------------------------------------------

let lastSync = 0;

/**
 * Reads every home on chain and brings the game in line: a home belongs to the player whose
 * wallet holds its deed, or to nobody in the game while an unlinked wallet holds it. At most
 * every `minGapS`, however often it's asked.
 */
export async function syncHomes(d: HomeDeps, minGapS = 20): Promise<number> {
  if (Date.now() - lastSync < minGapS * 1000) return 0;
  lastSync = Date.now();
  const links = new Map(
    (
      await d.db.query<{ near: string; id: string }>(
        'select near_account as near, account_id as id from near_wallets',
      )
    ).rows.map((r) => [r.near, r.id]),
  );
  let moved = 0;
  for (let from = 0; ; from += 100) {
    const page = await d.chain.homeTokens(from, 100);
    for (const t of page) {
      const holder = links.get(t.owner_id) ?? null;
      const r = await d.db.query<{ villa: number; account_id: string; away: boolean }>(
        `select h.villa, h.account_id, h.away from home_chain k join owned_homes h on h.villa = k.villa
         where k.asset = $1`,
        [t.token_id],
      );
      const h = r.rows[0];
      if (!h) continue;
      await d.db.query(
        "update home_chain set status = 'done', wallet = $2, updated_at = now() where villa = $1",
        [h.villa, t.owner_id],
      );
      if (holder === h.account_id && !h.away) continue;
      if (holder) {
        await d.db.query('update owned_homes set account_id = $2, away = false where villa = $1', [
          h.villa,
          holder,
        ]);
        if (holder !== h.account_id) moved += 1;
      } else if (!h.away) {
        await d.db.query('update owned_homes set away = true where villa = $1', [h.villa]);
      }
    }
    if (page.length < 100) break;
  }
  return moved;
}
