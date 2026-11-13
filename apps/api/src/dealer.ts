/**
 * Sol Motors, the business that runs itself (owner, 2026-11-13; shared BUYBACK, DEALERSHIP).
 * Its own NEAR wallet (contracts/business-wallet) gets USDC from players only: the cut of every
 * USDC car sale and the `$` top-ups. Each tick it counts what arrived, puts any car it holds up
 * for sale at a fair price, and may buy one car a player listed far under its worth.
 *
 * Three locks on its money, as with every business: an AI proposes (which car, what resale
 * price) seeing only numbers, never anything a player wrote; the rules here cut that to
 * BUYBACK's limits; and the wallet contract pays only the cars contract, within its per-payment
 * and daily limits, with no way to withdraw. Without an AI it keeps to the rules alone.
 *
 * In the game it's a player-like account, so its cars and listings show on the market under
 * its name. Nobody can log in as it: its id isn't a Privy id.
 */
import { randomUUID } from 'node:crypto';
import {
  BUYBACK,
  CAR_MODELS,
  clampBuyback,
  DEALERSHIP,
  fairUsdc,
  formatUsdc,
} from '@fr33world/shared';
import type { Ask } from './advisor.ts';
import { syncCars, type CarDeps } from './cars.ts';
import type { Db } from './db.ts';

/** What Sol Motors needs of NEAR beyond the car module's (packages/chain NearEconomy). */
export interface DealerChain {
  accountOf(short: string): string;
  carsAccount(): string;
  summary(wallet: string): Promise<{
    balance: string;
    reserved: string;
    spent_today: string;
    per_day: string;
    per_payment: string;
  }>;
  sync(wallet: string): Promise<{ tx: string }>;
  paySupplier(wallet: string, id: string, to: string, amount: number): Promise<{ tx: string }>;
  getOrder(wallet: string, id: string): Promise<{ status: string } | null>;
  walletListCar(wallet: string, tokenId: string, price: number): Promise<{ tx: string }>;
  carsOf(account: string): Promise<{ token_id: string }[]>;
  carListing(tokenId: string): Promise<{ seller: string; price: string } | null>;
}

export interface DealerDeps {
  db: Db;
  chain: DealerChain;
  cars: CarDeps;
  ask?: Ask;
  confirmGapMs?: number;
}

const PRIVY = 'system:sol-motors';

/** The dealership's account in the game: its cars and listings show under its name. */
export async function dealerAccount(db: Db, wallet: string): Promise<string> {
  await db.query(
    `insert into businesses (id, account, name, markup, target) values ($1, $2, $3, 0, 1)
     on conflict (id) do nothing`,
    [DEALERSHIP.id, wallet, DEALERSHIP.name],
  );
  await db.query(
    `insert into accounts (privy_user_id, display_name) values ($1, $2)
     on conflict (privy_user_id) do nothing`,
    [PRIVY, DEALERSHIP.name],
  );
  const r = await db.query<{ id: string }>('select id from accounts where privy_user_id = $1', [
    PRIVY,
  ]);
  const id = r.rows[0]!.id;
  await db.query(
    `insert into characters (account_id, name, age, appearance) values ($1, $2, 30, 0)
     on conflict do nothing`,
    [id, DEALERSHIP.name],
  );
  await db.query(
    `insert into near_wallets (account_id, near_account, registered) values ($1, $2, true)
     on conflict do nothing`,
    [id, wallet],
  );
  return id;
}

const SYSTEM = `You run the buying desk of a car dealership in a game. Players sell cars to each
other; you may buy one that is listed far under its worth, then sell it again. Reply with one JSON
object only: {"buy": index or null, "relist": number, "reason": "one short sentence"}.
buy is the index of the car to buy from the list, or null to buy nothing. relist is the resale
price as a share of the car's worth, between 0.9 and 1.2. Keep money for later: don't buy just
because you can.`;

interface Candidate {
  listing: number;
  token: string;
  model: string;
  price: number;
  worth: number;
}

const decide = (db: Db, source: 'rule' | 'ai', summary: string, details: object) =>
  db.query(
    `insert into business_decisions (business, source, summary, details) values ($1, $2, $3, $4)`,
    [DEALERSHIP.id, source, summary, details],
  );

/** Letters, digits and plain punctuation only: a reason is shown to players. */
const plain = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replace(/[^\w\s.,'%()-]/g, '')
        .slice(0, 200)
        .trim()
    : '';

/** One round for Sol Motors. Never throws: a bad round waits for the next. */
export async function dealerTick(
  d: DealerDeps,
): Promise<{ bought: string | null; listed: number }> {
  const wallet = d.chain.accountOf(DEALERSHIP.account);
  let listed = 0;
  let bought: string | null = null;
  try {
    await dealerAccount(d.db, wallet);
    // USDC from a resale arrives by plain transfer, which only `sync` counts.
    await d.chain.sync(wallet).catch(() => {});

    // Every car it holds goes up for sale at a fair price.
    for (const t of await d.chain.carsOf(wallet)) {
      if (await d.chain.carListing(t.token_id)) continue;
      const price = await relistPrice(d, t.token_id);
      if (price === null) continue;
      await d.chain.walletListCar(wallet, t.token_id, price);
      await decide(d.db, 'rule', `Put a car back on sale for ${formatUsdc(price)}`, {
        token: t.token_id,
        price,
      });
      listed += 1;
    }

    const held = (await d.chain.carsOf(wallet)).length;
    if (held >= BUYBACK.holdMax) return { bought, listed };
    const s = await d.chain.summary(wallet);
    const free = Number(BigInt(s.balance) - BigInt(s.reserved));
    const leftToday = Number(BigInt(s.per_day) - BigInt(s.spent_today));
    const cap = Math.min(free * BUYBACK.spendShare, Number(s.per_payment), leftToday);
    const candidates = await bargains(d, wallet, cap);
    if (candidates.length === 0) return { bought, listed };

    let choice = { buy: 0 as number | null, relist: 1 };
    let source: 'rule' | 'ai' = 'rule';
    let reason = 'The deepest discount on the market';
    if (d.ask) {
      try {
        const answer = parse(
          await d.ask(
            SYSTEM,
            JSON.stringify({
              freeUsdc: free / 1e6,
              carsHeld: held,
              cars: candidates.map((c, i) => ({
                index: i,
                model: c.model,
                priceUsdc: c.price / 1e6,
                worthUsdc: c.worth / 1e6,
              })),
            }),
          ),
        );
        if (answer) {
          choice = clampBuyback(answer, candidates.length);
          source = 'ai';
          reason =
            plain(answer.reason) || (choice.buy === null ? 'Nothing worth buying' : 'A good buy');
        }
      } catch (e) {
        console.error('dealer advisor', e);
      }
    }
    if (choice.buy === null) {
      await decide(d.db, source, reason, { candidates: candidates.length, free });
      return { bought, listed };
    }
    const c = candidates[choice.buy]!;
    const order = `${c.token}:${randomUUID().slice(0, 8)}`;
    await d.db.query(
      `insert into business_decisions (business, source, summary, details) values ($1, $2, $3, $4)`,
      [
        DEALERSHIP.id,
        source,
        `Bought a ${c.model} listed at ${formatUsdc(c.price)}, worth ${formatUsdc(c.worth)}: ${reason}`,
        { token: c.token, price: c.price, worth: c.worth, relist: choice.relist, order },
      ],
    );
    await d.chain.paySupplier(wallet, order, d.chain.carsAccount(), c.price);
    let o = await d.chain.getOrder(wallet, order);
    for (let i = 0; i < 6 && o?.status === 'pending'; i += 1) {
      await new Promise((r) => setTimeout(r, d.confirmGapMs ?? 1500));
      o = await d.chain.getOrder(wallet, order);
    }
    await d.db.query(
      `insert into dealer_relists (token, share) values ($1, $2)
       on conflict (token) do update set share = $2`,
      [c.token, choice.relist],
    );
    await syncCars(d.cars, 0);
    if (o?.status === 'paid') bought = c.token;
  } catch (e) {
    console.error('dealer tick', e);
  }
  return { bought, listed };
}

/** Listings for USDC under BUYBACK's share of their worth, that the wallet can pay for. */
async function bargains(d: DealerDeps, wallet: string, cap: number): Promise<Candidate[]> {
  const r = await d.db.query<{ id: number; model: number; micro: string; token: string }>(
    `select l.id, o.model, l.micro, c.asset as token from car_listings l
     join owned_cars o on o.id = l.car_id join car_chain c on c.car_id = l.car_id
     where l.status = 'open' and l.micro is not null and c.status = 'done' and c.wallet <> $1
     order by l.id`,
    [wallet],
  );
  const out: Candidate[] = [];
  for (const l of r.rows) {
    const worth = fairUsdc(l.model);
    const price = Number(l.micro);
    if (!worth || price > worth * BUYBACK.under || price > cap) continue;
    // The chain's price is the one that counts.
    const onChain = await d.chain.carListing(l.token);
    if (!onChain || Number(onChain.price) !== price) continue;
    out.push({
      listing: l.id,
      token: l.token,
      model: CAR_MODELS[l.model]?.name ?? 'Car',
      price,
      worth,
    });
  }
  // Deepest discount first, so "the first" is the rule's own pick.
  return out.sort((a, b) => a.price / a.worth - b.price / b.worth).slice(0, 5);
}

/** What a held car sells for: its worth times the share chosen when it was bought. */
async function relistPrice(d: DealerDeps, token: string): Promise<number | null> {
  const r = await d.db.query<{ model: number; share: string | null }>(
    `select o.model, x.share from car_chain c join owned_cars o on o.id = c.car_id
     left join dealer_relists x on x.token = c.asset where c.asset = $1`,
    [token],
  );
  const row = r.rows[0];
  if (!row) return null;
  const worth = fairUsdc(row.model);
  if (!worth) return null;
  const share = Math.min(BUYBACK.relistMax, Math.max(BUYBACK.relistMin, Number(row.share ?? 1)));
  return Math.max(1_000_000, Math.round((worth * share) / 10_000) * 10_000);
}

function parse(text: string): Record<string, unknown> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
