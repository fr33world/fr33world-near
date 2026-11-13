/**
 * Cars as assets on NEAR (owner, 2026-11-13; shared assets.ts, contracts/cars). A car bought at
 * the dealership is minted to the buyer's own NEAR wallet: its title deed. From then on the
 * chain says who owns it and the garage follows: a car sent or sold on chain moves to the
 * player whose wallet holds it, or leaves every garage while an unlinked wallet holds it.
 *
 * Everything a player does with their car on chain (list it for USDC, offer it for `$`, take
 * it down, send it) is signed on their own device: the game prepares one transaction, the
 * player signs it, and the game sends it. A NEAR account signs one transaction at a time, so
 * an action goes in steps: each call looks at the chain, sends a signed step if it was given
 * one, and hands back the next step to sign, until nothing is missing. A retry is always safe.
 *
 * `$` never becomes USDC here: a USDC sale pays the seller from the buyer's own USDC, on chain.
 */
import {
  CAR_ASSETS,
  CAR_MODELS,
  carIdOf,
  carTitle,
  carToken,
  DEALER,
  formatUsdc,
} from '@fr33world/shared';
import { BankError } from './bank.ts';
import { type Db, inTx, type Tx } from './db.ts';

/** A car on the cars contract, as `nft_token` returns it. */
export interface ChainCar {
  token_id: string;
  owner_id: string;
}

export interface ChainListing {
  seller: string;
  price: string;
}

export type CarCall =
  | { method: 'list_car'; tokenId: string; price: number }
  | { method: 'delist_car' | 'offer_to_game' | 'withdraw_offer'; tokenId: string }
  | { method: 'nft_transfer'; tokenId: string; receiver: string };

/** What this module needs of NEAR (packages/chain NearEconomy), so tests can stand in. */
export interface CarChain {
  carsAccount(): string;
  explorer?(kind: 'address' | 'txns', id: string): string;
  mintCar(
    tokenId: string,
    owner: string,
    metadata: { title: string; description: string; media: string | null; extra: string },
  ): Promise<{ tx: string }>;
  gameTransfer(tokenId: string, receiver: string): Promise<{ tx: string }>;
  carToken(tokenId: string): Promise<ChainCar | null>;
  carTokens(from: number, limit: number): Promise<ChainCar[]>;
  carListing(tokenId: string): Promise<ChainListing | null>;
  carListings(): Promise<[string, ChainListing][]>;
  isOffered(tokenId: string): Promise<boolean>;
  /** When the car may next be sent or listed (ms); 0 if now. */
  carLockedUntil(tokenId: string): Promise<number>;
  ensureGas(account: string): Promise<void>;
  usdcBalance(account: string): Promise<bigint>;
  prepareCar(account: string, call: CarCall): Promise<{ tx: string; hash: string }>;
  prepare(
    account: string,
    spend: { method: 'ft_transfer_call'; receiver: string; amount: number; msg: string },
  ): Promise<{ tx: string; hash: string }>;
  submit(account: string, tx: string, signature: string): Promise<{ tx: string }>;
}

export interface CarDeps {
  db: Db;
  chain: CarChain;
  /** Links the player's Privy NEAR wallet if it isn't yet (usdc.ts linkWallet). */
  link: (privyUser: string) => Promise<{ near: string }>;
  /** Somewhere to say the chain and the database disagree. */
  alert?: (text: string) => void;
  /** Between looks for a transaction's effect on chain (ms). */
  confirmGapMs?: number;
}

/** One transaction for the player to sign, and what it does, for the screen. */
export interface Step {
  tx: string;
  hash: string;
  what: string;
}

/** What a step call answers: the next thing to sign, or nothing left to do. */
export type StepResult<T> = { step: Step; done?: undefined } | { step?: undefined; done: T };

// ---- Players and their cars ----------------------------------------------------------------

interface Me {
  id: string;
  near: string;
  name: string;
}

/** A full account with a character and a linked NEAR wallet: who may trade cars on chain. */
async function trader(d: CarDeps, privyUser: string): Promise<Me> {
  const r = await d.db.query<{ id: string; guest: boolean; name: string | null }>(
    `select a.id, a.is_guest as guest, c.name from accounts a
     left join characters c on c.account_id = a.id where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me) throw new BankError('Please log in again.', 401);
  if (!me.name) throw new BankError('Make your character first.', 403);
  if (me.guest)
    throw new BankError(
      'Guest accounts can’t trade cars. Link an email or social login first.',
      403,
    );
  const { near } = await d.link(privyUser);
  return { id: me.id, near, name: me.name };
}

interface MyCar {
  id: number;
  model: number;
  token: string | null;
  starter: boolean;
}

/** One of the player's own cars, with its token once it's minted. */
async function myCar(db: Db | Tx, me: Me, car: unknown): Promise<MyCar> {
  const id = Number(car);
  if (!Number.isSafeInteger(id)) throw new BankError('Which car?');
  const r = await db.query<{ model: number; starter: boolean; token: string | null }>(
    `select o.model, o.starter, case when c.status = 'done' then c.asset end as token
     from owned_cars o left join car_chain c on c.car_id = o.id
     where o.id = $1 and o.account_id = $2 and not o.away
       and (o.expires_at is null or o.expires_at > now())`,
    [id, me.id],
  );
  const row = r.rows[0];
  if (!row) throw new BankError('That isn’t your car.', 404);
  if (row.starter) throw new BankError('The rental belongs to the Car Dealership.');
  return { id, ...row };
}

function minted(c: MyCar): string {
  if (!c.token)
    throw new BankError('Its title deed is still on its way to your wallet. Try in a minute.', 409);
  return c.token;
}

async function unlocked(d: CarDeps, token: string) {
  const until = await d.chain.carLockedUntil(token);
  if (until > Date.now()) {
    const mins = Math.ceil((until - Date.now()) / 60_000);
    const wait = mins >= 120 ? `${Math.ceil(mins / 60)} hours` : `${mins} min`;
    throw new BankError(
      `New and just-sold cars are locked for a while: this one for ${wait} more.`,
      429,
    );
  }
}

/** Sends a step the player signed. A step for some other account is refused by the chain module. */
async function sendSigned(d: CarDeps, me: Me, body: { tx?: unknown; signature?: unknown }) {
  if (body.tx === undefined) return null;
  if (typeof body.tx !== 'string' || typeof body.signature !== 'string')
    throw new BankError('Bad request.');
  try {
    return (await d.chain.submit(me.near, body.tx, body.signature)).tx;
  } catch (e) {
    console.error('car step', e);
    throw new BankError('That didn’t go through on chain. Try again.', 502);
  }
}

async function step(d: CarDeps, me: Me, call: CarCall, what: string): Promise<{ step: Step }> {
  await d.chain.ensureGas(me.near);
  const p = await d.chain.prepareCar(me.near, call);
  return { step: { ...p, what } };
}

/** Waits a few seconds for a node to show what a transaction just did. */
async function settle<T>(d: CarDeps, look: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await look();
  for (let i = 0; i < 5 && !ok(v); i += 1) {
    await new Promise((r) => setTimeout(r, d.confirmGapMs ?? 1000));
    v = await look();
  }
  return v;
}

// ---- Minting -------------------------------------------------------------------------------

/** Queues a title deed for each of the player's own cars that hasn't one, once they have a wallet. */
export async function queueMints(db: Db | Tx, accountId: string): Promise<number> {
  const r = await db.query(
    `insert into car_chain (car_id, status, wallet, asset)
     select o.id, 'mint', w.near_account, 'car-' || o.id
     from owned_cars o join near_wallets w on w.account_id = o.account_id
     where o.account_id = $1 and not o.starter and not o.away
       and (o.expires_at is null or o.expires_at > now())
     on conflict (car_id) do nothing`,
    [accountId],
  );
  return r.rowCount ?? 0;
}

function backoff(attempts: number): number {
  return Math.min(6 * 3600, 30 * 2 ** attempts);
}

/** What a car's title deed says in any NEAR wallet. */
export function deedFor(model: number, carId: number) {
  const m = CAR_MODELS[model];
  return {
    title: carTitle(model, carId),
    description: `A ${m?.name ?? 'car'} in fr33world, the city game in the browser, bought at the Car Dealership on Sol Boulevard. Whoever holds this owns the car in the game.`,
    media: m ? `${CAR_ASSETS.mediaBase}${m.id}.webp` : null,
    extra: JSON.stringify({ game: 'fr33world', car: carId, model: m?.id ?? null }),
  };
}

/** Mints queued title deeds. Asks the chain first, so a retry never mints twice. */
export async function runMints(d: CarDeps): Promise<number> {
  const due = await d.db.query<{
    car_id: number;
    wallet: string;
    asset: string;
    attempts: number;
    model: number;
  }>(
    `select c.car_id, c.wallet, c.asset, c.attempts, o.model from car_chain c
     join owned_cars o on o.id = c.car_id
     where c.status = 'mint' and c.next_at <= now() order by c.next_at limit 10`,
  );
  let done = 0;
  for (const m of due.rows) {
    try {
      let t = await d.chain.carToken(m.asset);
      if (!t) {
        await d.chain.mintCar(m.asset, m.wallet, deedFor(m.model, Number(m.car_id)));
        t = await settle(
          d,
          () => d.chain.carToken(m.asset),
          (x) => x !== null,
        );
      }
      if (!t) throw new Error('not on chain after minting');
      await d.db.query(
        `update car_chain set status = 'done', wallet = $2, last_error = null, updated_at = now()
         where car_id = $1`,
        [m.car_id, t.owner_id],
      );
      done += 1;
    } catch (e) {
      await d.db.query(
        `update car_chain set attempts = attempts + 1, last_error = $2, updated_at = now(),
           next_at = now() + make_interval(secs => $3) where car_id = $1`,
        [m.car_id, (e instanceof Error ? e.message : String(e)).slice(0, 300), backoff(m.attempts)],
      );
    }
  }
  return done;
}

// ---- Following the chain -------------------------------------------------------------------

/**
 * Reads every car and listing on chain and brings the game in line: a car moves to the player
 * whose wallet holds it, or is away while an unlinked wallet holds it, and USDC prices follow
 * the contract's listings. At most every `minGapS`, however often it's asked.
 */
export async function syncCars(d: CarDeps, minGapS = 20): Promise<{ ran: boolean; moved: number }> {
  const claimed = await d.db.query(
    `update car_sync set last_at = now()
     where last_at is null or last_at <= now() - make_interval(secs => $1) returning id`,
    [minGapS],
  );
  if (claimed.rowCount === 0) return { ran: false, moved: 0 };
  const links = new Map(
    (
      await d.db.query<{ near: string; id: string }>(
        'select near_account as near, account_id as id from near_wallets',
      )
    ).rows.map((r) => [r.near, r.id]),
  );
  let moved = 0;
  for (let from = 0; ; from += 100) {
    const page = await d.chain.carTokens(from, 100);
    for (const t of page) if (await follow(d, t, links)) moved += 1;
    if (page.length < 100) break;
  }
  await followListings(d, links);
  return { ran: true, moved };
}

/** Brings one car in line with its holder on chain. True if it changed hands in the game. */
async function follow(d: CarDeps, t: ChainCar, links: Map<string, string>): Promise<boolean> {
  const carId = carIdOf(t.token_id);
  if (carId === null) return false;
  const holder = links.get(t.owner_id) ?? null;
  return inTx(d.db, async (tx) => {
    const r = await tx.query<{ account_id: string; away: boolean }>(
      'select account_id, away from owned_cars where id = $1 for update',
      [carId],
    );
    const car = r.rows[0];
    if (!car) return false;
    await tx.query(
      `insert into car_chain (car_id, status, wallet, asset) values ($1, 'done', $2, $3)
       on conflict (car_id) do update set status = 'done', wallet = $2, updated_at = now()`,
      [carId, t.owner_id, t.token_id],
    );
    if (holder === car.account_id) {
      if (car.away) await tx.query('update owned_cars set away = false where id = $1', [carId]);
      return false;
    }
    // It left its owner's wallet: whatever was listed is over.
    await tx.query(
      `update car_listings set status = $2, buyer = $3, closed_at = now(),
         paid_in = case when $3::uuid is not null and micro is not null then 'usdc' end
       where car_id = $1 and status = 'open'`,
      [carId, holder ? 'sold' : 'withdrawn', holder],
    );
    if (holder) {
      await tx.query('update owned_cars set account_id = $2, away = false where id = $1', [
        carId,
        holder,
      ]);
      return true;
    }
    await tx.query('update owned_cars set away = true where id = $1', [carId]);
    return false;
  });
}

/** USDC prices follow the contract; a listing made on chain outside the game shows too. */
async function followListings(d: CarDeps, links: Map<string, string>) {
  const onChain = new Map(await d.chain.carListings());
  const open = await d.db.query<{
    id: number;
    car_id: number;
    seller: string;
    micro: string | null;
    price: string | null;
  }>("select id, car_id, seller, micro, price from car_listings where status = 'open'");
  const listed = new Set<number>();
  for (const l of open.rows) {
    listed.add(Number(l.car_id));
    const c = onChain.get(carToken(l.car_id));
    const micro = c && links.get(c.seller) === l.seller ? Number(c.price) : null;
    if (micro === (l.micro === null ? null : Number(l.micro))) continue;
    if (micro === null && l.price === null)
      await d.db.query(
        "update car_listings set status = 'withdrawn', closed_at = now() where id = $1",
        [l.id],
      );
    else await d.db.query('update car_listings set micro = $2 where id = $1', [l.id, micro]);
  }
  for (const [token, c] of onChain) {
    const carId = carIdOf(token);
    const seller = links.get(c.seller);
    if (carId === null || !seller || listed.has(carId)) continue;
    await d.db.query(
      `insert into car_listings (car_id, seller, micro, status)
       select id, account_id, $2, 'open' from owned_cars
       where id = $1 and account_id = $3 and not away
       on conflict do nothing`,
      [carId, Number(c.price), seller],
    );
  }
}

// ---- Listing: `$`, USDC, or both ---------------------------------------------------------

export interface ListInput {
  car?: unknown;
  /** `$` price in cents, or null for none. */
  price?: unknown;
  /** USDC price in micro-USDC, or null for none. */
  micro?: unknown;
  tx?: unknown;
  signature?: unknown;
}

function priceOf(v: unknown, label: string, min: number, max: number): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    throw new BankError(`${label} is out of range.`);
  return v;
}

/**
 * Lists a minted car for `$`, USDC, or both, in steps (see the top of this file). The `$` price
 * keeps the market's bounds (market.ts priceBounds, passed in); the USDC price is the seller's.
 */
export async function listOnChain(
  d: CarDeps,
  privyUser: string,
  body: ListInput,
  bounds: (model: number) => { min: number; max: number },
  offChain: (
    db: Db,
    privyUser: string,
    input: { car: number; price: number | null },
  ) => Promise<{ id: number }>,
): Promise<StepResult<{ id: number }>> {
  const me = await trader(d, privyUser);
  const car = await myCar(d.db, me, body.car);
  const b = bounds(car.model);
  const price = priceOf(body.price, 'The $ price', b.min, b.max);
  const micro = priceOf(body.micro, 'The USDC price', CAR_ASSETS.minPrice, CAR_ASSETS.maxPrice);
  if (price === null && micro === null) throw new BankError('Give it a price in $, USDC or both.');
  // A car not on chain yet trades off chain, for `$` only.
  if (!car.token) {
    if (micro !== null) minted(car);
    return { done: await offChain(d.db, privyUser, { car: car.id, price }) };
  }
  const token = car.token;
  if (micro !== null) {
    const sold = await d.db.query<{ n: number }>(
      `select count(*)::int as n from car_listings where seller = $1 and paid_in = 'usdc'
       and closed_at > now() - interval '1 day'`,
      [me.id],
    );
    if ((sold.rows[0]?.n ?? 0) >= CAR_ASSETS.salesPerDay)
      throw new BankError(
        `That’s ${CAR_ASSETS.salesPerDay} USDC sales today. List it tomorrow.`,
        429,
      );
  }
  const open = await d.db.query<{ n: number }>(
    "select count(*)::int as n from car_listings where seller = $1 and status = 'open' and car_id <> $2",
    [me.id, car.id],
  );
  if ((open.rows[0]?.n ?? 0) >= CAR_ASSETS.maxListings)
    throw new BankError(`At most ${CAR_ASSETS.maxListings} cars for sale at once.`);
  await sendSigned(d, me, body);
  await unlocked(d, token);

  const offered = await d.chain.isOffered(token);
  if (price !== null && !offered)
    return step(
      d,
      me,
      { method: 'offer_to_game', tokenId: token },
      'Let the game hand it over for $',
    );
  const listing = await d.chain.carListing(token);
  if (micro !== null && (listing?.seller !== me.near || Number(listing.price) !== micro))
    return step(
      d,
      me,
      { method: 'list_car', tokenId: token, price: micro },
      `List it for ${formatUsdc(micro)}`,
    );
  if (micro === null && listing)
    return step(d, me, { method: 'delist_car', tokenId: token }, 'Take the USDC price down');

  const r = await inTx(d.db, async (tx) => {
    const was = await tx.query<{ id: number }>(
      "update car_listings set price = $2, micro = $3 where car_id = $1 and status = 'open' returning id",
      [car.id, price, micro],
    );
    if (was.rows[0]) return was.rows[0];
    const ins = await tx.query<{ id: number }>(
      `insert into car_listings (car_id, seller, price, micro, status) values ($1, $2, $3, $4, 'open')
       returning id`,
      [car.id, me.id, price, micro],
    );
    return ins.rows[0]!;
  });
  return { done: { id: r.id } };
}

/** Takes a minted car off sale: the USDC listing comes down and the `$` offer is withdrawn. */
export async function unlistOnChain(
  d: CarDeps,
  privyUser: string,
  body: { id?: unknown; tx?: unknown; signature?: unknown },
): Promise<StepResult<{ withdrawn: true }>> {
  const me = await trader(d, privyUser);
  const r = await d.db.query<{ car_id: number }>(
    "select car_id from car_listings where id = $1 and seller = $2 and status = 'open'",
    [Number(body.id), me.id],
  );
  const l = r.rows[0];
  if (!l) throw new BankError('Not your listing, or not for sale any more.');
  await sendSigned(d, me, body);
  const token = carToken(l.car_id);
  const minted = await d.chain.carToken(token);
  if (minted?.owner_id === me.near) {
    const listing = await d.chain.carListing(token);
    if (listing?.seller === me.near)
      return step(d, me, { method: 'delist_car', tokenId: token }, 'Take the USDC price down');
    if (await d.chain.isOffered(token))
      return step(d, me, { method: 'withdraw_offer', tokenId: token }, 'Stop the $ sale');
  }
  await d.db.query(
    "update car_listings set status = 'withdrawn', closed_at = now() where id = $1 and status = 'open'",
    [Number(body.id)],
  );
  return { done: { withdrawn: true } };
}

// ---- Buying for USDC -------------------------------------------------------------------------

/**
 * Buys a listed car for USDC: one step, the buyer's own USDC paid to the cars contract, which
 * moves the car and pays the seller in the same transaction. Then the garage follows.
 */
export async function buyForUsdc(
  d: CarDeps,
  privyUser: string,
  body: { id?: unknown; tx?: unknown; signature?: unknown },
): Promise<StepResult<{ car: number; micro: number; tx: string | null }>> {
  const me = await trader(d, privyUser);
  const id = Number(body.id);
  const r = await d.db.query<{
    car_id: number;
    seller: string;
    micro: string | null;
    status: string;
    buyer: string | null;
  }>('select car_id, seller, micro, status, buyer from car_listings where id = $1', [id]);
  const l = r.rows[0];
  if (!l || l.micro === null) throw new BankError('That car isn’t for sale for USDC.', 404);
  const token = carToken(l.car_id);
  const sent = await sendSigned(d, me, body);
  if (sent) {
    const t = await settle(
      d,
      () => d.chain.carToken(token),
      (x) => x?.owner_id === me.near,
    );
    if (t?.owner_id !== me.near)
      throw new BankError('The payment didn’t go through. Your USDC is back in your wallet.', 402);
    await inTx(d.db, async (tx) => {
      await tx.query(
        `update car_listings set status = 'sold', buyer = $2, paid_in = 'usdc', tx = $3, closed_at = now()
         where id = $1 and status = 'open'`,
        [id, me.id, sent],
      );
      await tx.query('update owned_cars set account_id = $2, away = false where id = $1', [
        l.car_id,
        me.id,
      ]);
      await tx.query('update car_chain set wallet = $2, updated_at = now() where car_id = $1', [
        l.car_id,
        me.near,
      ]);
    });
    return { done: { car: l.car_id, micro: Number(l.micro), tx: sent } };
  }
  if (l.status !== 'open') throw new BankError('Already sold, or taken down.', 409);
  if (l.seller === me.id) throw new BankError('That’s your own car.');
  const owned = await d.db.query<{ n: number }>(
    `select count(*)::int as n from owned_cars where account_id = $1 and not away
     and (expires_at is null or expires_at > now())`,
    [me.id],
  );
  if ((owned.rows[0]?.n ?? 0) >= DEALER.garageMax)
    throw new BankError(`Your garage is full (${DEALER.garageMax} cars).`, 409);
  const listing = await d.chain.carListing(token);
  if (!listing || Number(listing.price) !== Number(l.micro)) {
    await syncCars(d, 0);
    throw new BankError('Its price just changed. Look again.', 409);
  }
  const micro = Number(l.micro);
  if ((await d.chain.usdcBalance(me.near)) < BigInt(micro))
    throw new BankError('Not enough USDC.', 402);
  await d.chain.ensureGas(me.near);
  const p = await d.chain.prepare(me.near, {
    method: 'ft_transfer_call',
    receiver: d.chain.carsAccount(),
    amount: micro,
    msg: token,
  });
  return { step: { ...p, what: `Pay ${formatUsdc(micro)}` } };
}

// ---- `$` sales of minted cars ------------------------------------------------------------------

/**
 * For the `$` market (market.ts): before a minted car's `$` sale is booked, the seller's offer
 * must be on chain. Returns the token, or null for a car not minted (it trades off chain).
 */
export async function dollarSaleToken(d: CarDeps, carId: number): Promise<string | null> {
  const r = await d.db.query<{ asset: string; status: string }>(
    'select asset, status from car_chain where car_id = $1',
    [carId],
  );
  const c = r.rows[0];
  if (!c) return null;
  if (c.status !== 'done')
    throw new BankError('Its title deed is still on its way. Try in a minute.', 409);
  if (!(await d.chain.isOffered(c.asset)))
    throw new BankError('The seller hasn’t allowed this sale on chain yet.', 409);
  return c.asset;
}

// ---- Sending ---------------------------------------------------------------------------------

/** Sends a car to any NEAR account, in one step. It leaves the game if no player holds that wallet. */
export async function sendCar(
  d: CarDeps,
  privyUser: string,
  body: { car?: unknown; to?: unknown; tx?: unknown; signature?: unknown },
): Promise<StepResult<{ to: string; tx: string | null }>> {
  const me = await trader(d, privyUser);
  const to = body.to;
  if (typeof to !== 'string' || !NEAR_ACCOUNT.test(to) || to.length < 2 || to.length > 64)
    throw new BankError('That isn’t a NEAR account.');
  const r = await d.db.query<{ car_id: number }>(
    "select car_id from car_chain where car_id = $1 and wallet = $2 and status = 'done'",
    [Number(body.car), me.near],
  );
  if (!r.rows[0]) {
    const car = await myCar(d.db, me, body.car);
    minted(car);
  }
  const token = carToken(Number(body.car));
  const sent = await sendSigned(d, me, body);
  if (sent) {
    await settle(
      d,
      () => d.chain.carToken(token),
      (x) => x?.owner_id === to,
    );
    await syncCars(d, 0);
    return { done: { to, tx: sent } };
  }
  if (to === me.near) throw new BankError('It’s already in your wallet.');
  await unlocked(d, token);
  return step(d, me, { method: 'nft_transfer', tokenId: token, receiver: to }, `Send it to ${to}`);
}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** What the garage shows about a car's title deed. */
export async function deedsOf(
  db: Db | Tx,
  carIds: number[],
): Promise<Map<number, { token: string; minted: boolean }>> {
  if (carIds.length === 0) return new Map();
  const r = await db.query<{ car_id: string; asset: string; status: string }>(
    'select car_id, asset, status from car_chain where car_id = any($1::bigint[])',
    [carIds],
  );
  return new Map(
    r.rows.map((c) => [Number(c.car_id), { token: c.asset, minted: c.status === 'done' }]),
  );
}
