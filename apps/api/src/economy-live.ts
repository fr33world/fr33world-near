/**
 * The economy's whole story, through the real API routes and the real testnet:
 *   pnpm --filter @fr33world/api economy:live
 * Ava buys a Sedan with `$` and its title deed is minted to her own NEAR wallet. Ben tops up `$`
 * with USDC, which goes to Sol Motors' wallet. Ava lists the Sedan for `$` and USDC at once;
 * Ben buys it with USDC, on chain: the car moves to him, Ava is paid, Sol Motors gets its cut.
 * Ben sells it back to Ava for `$`, and the game hands it over on chain. Ava sends it to a
 * wallet outside the game, and it leaves her garage.
 *
 * Only Privy is stood in for: a local key signs the same hash Privy would. The database is a
 * scratch schema in fr33world_test. Needs NEAR_ROOT_KEY and NEAR_OPERATOR_KEY. Testnet only.
 * New and sold cars are locked for an hour on testnet, so the run sets the locks to nothing
 * while it runs and puts them back after, whatever happens.
 * With KEEP=1 the API stays up on port 7411 afterwards, to look at the economy page.
 */
import {
  economyFromEnv,
  nearblocks,
  prepareCarCall,
  prepareSpend,
  submitSigned,
} from '@fr33world/chain';
import {
  fundFromShopper,
  setCarLocks,
  testWallet,
  type TestWallet,
} from '@fr33world/chain/testkit';
import { CAR_ASSETS, CAR_MODELS, carPrice, DEALERSHIP, USDC } from '@fr33world/shared';
import { buildApp } from './app.ts';
import { tick } from './business.ts';
import { runMints, syncCars } from './cars.ts';
import { balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { priceBounds } from './market.ts';
import { linkWallet } from './usdc.ts';
import { testDb } from './test-db.ts';

const near = economyFromEnv();
if (near.cfg.network !== 'testnet') throw new Error('testnet only');
const rootKey = process.env.NEAR_ROOT_KEY;
if (!rootKey || !process.env.NEAR_OPERATOR_KEY) throw new Error('needs the testnet keys in .env');

const chain = Object.assign(near, {
  prepare: (account: string, spend: Parameters<typeof prepareSpend>[2]) =>
    prepareSpend(near, account, spend),
  prepareCar: (account: string, call: Parameters<typeof prepareCarCall>[2]) =>
    prepareCarCall(near, account, call),
  submit: (account: string, tx: string, signature: string) =>
    submitSigned(near, account, tx, signature),
});
const db = await testDb('live');
const alerts: string[] = [];
const players = new Map<string, { privy: string; wallet: TestWallet }>([
  ['ava', { privy: 'did:privy:live-ava', wallet: testWallet() }],
  ['ben', { privy: 'did:privy:live-ben', wallet: testWallet() }],
]);
const byPrivy = new Map([...players.values()].map((p) => [p.privy, p.wallet.account]));
const usdc = {
  db,
  chain,
  confirmGapMs: 1500,
  walletOf: (privy: string) => Promise.resolve(byPrivy.get(privy) ?? null),
};
const cars = {
  db,
  chain,
  confirmGapMs: 1500,
  link: (privy: string) => linkWallet(usdc, privy),
  alert: (t: string) => alerts.push(t),
};
const app = buildApp({
  db,
  verify: (token) => Promise.resolve(players.get(token)?.privy ?? null),
  isGuest: () => Promise.resolve(false),
  ticketSecret: 'live-run-ticket-secret-0123456789abcdef',
  corsOrigins: ['http://localhost:5173', 'http://localhost:5199'],
  economy: { db, chain, alert: (t: string) => alerts.push(t) },
  usdc,
  cars,
});

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
};
const link = (hash?: string | null) => (hash ? `     ${nearblocks(near.cfg, 'txns', hash)}` : '');

async function call<T>(who: string, method: 'GET' | 'POST', url: string, payload?: object) {
  const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${who}` } });
  if (r.statusCode >= 400) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
  return r.json<T>();
}

type Stepped<T> = { step?: { tx: string; hash: string; what: string }; done?: T };
/** Calls a step route to the end, signing each step with the player's own key. */
async function steps<T>(who: string, url: string, body: object): Promise<T> {
  const wallet = players.get(who)!.wallet;
  let r = await call<Stepped<T>>(who, 'POST', url, body);
  while (r.step) {
    console.log(`     ${who} signs: ${r.step.what}`);
    r = await call<Stepped<T>>(who, 'POST', url, {
      ...body,
      tx: r.step.tx,
      signature: wallet.sign(r.step.hash),
    });
  }
  return r.done as T;
}

async function person(who: string, cents: number) {
  const p = players.get(who)!;
  const made = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name, is_guest) values ($1, $2, false) returning id',
    [p.privy, who],
  );
  const id = made.rows[0]!.id;
  await db.query(
    `insert into characters (account_id, name, age, appearance) values ($1, $2, 25, 0)`,
    [id, who === 'ava' ? 'Ava Live' : 'Ben Live'],
  );
  if (cents > 0)
    await transfer(db, {
      kind: 'signup_bonus',
      key: `live-${id}`,
      legs: [
        { account: await systemAccount(db, 'faucet:signup'), amount: -cents },
        { account: await walletOf(db, id), amount: cents },
      ],
    });
  await call(who, 'POST', '/v1/usdc/link', {});
  return { id, near: p.wallet.account };
}
const dollars = async (id: string) => balanceOf(db, await walletOf(db, id));
const owner = async (token: string) => (await near.carToken(token))?.owner_id;
const dealer = near.accountOf(DEALERSHIP.account);
const dealerHas = async () => BigInt((await near.summary(dealer)).balance);

const setLocks = (ns: number) => setCarLocks(near, rootKey, ns);
const hourNs = CAR_ASSETS.lockHours.testnet * 3_600_000_000_000;

try {
  await setLocks(0);
  await tick({ db, chain, alert: (t: string) => alerts.push(t) }, 0);
  const sedan = CAR_MODELS.findIndex((m) => m.id === 'sedan');
  const ava = await person('ava', carPrice(sedan)! + 2_000_000);
  const ben = await person('ben', 0);
  check('both wallets are linked', Boolean(ava.near && ben.near));

  // 1. A car bought with `$` is minted to the buyer's own wallet.
  const bought = await call<{ car: { id: number } }>('ava', 'POST', '/v1/dealer/buy', {
    model: sedan,
    key: `live-${Date.now()}`,
  });
  await runMints(cars);
  const token =
    (
      await db.query<{ asset: string }>('select asset from car_chain where car_id = $1', [
        bought.car.id,
      ])
    ).rows[0]?.asset ?? 'none';
  check('the Sedan’s title deed is in Ava’s own wallet', (await owner(token)) === ava.near, token);
  const garage = await call<{ cars: { id: number; minted: boolean }[] }>(
    'ava',
    'GET',
    '/v1/garage',
  );
  check(
    'her garage shows it on chain',
    garage.cars.some((c) => c.id === bought.car.id && c.minted),
  );

  // 2. USDC into `$`, one way: the USDC goes to Sol Motors' wallet first.
  await fundFromShopper(near, rootKey, ben.near, 12 * USDC);
  const before = await dealerHas();
  const t = await call<{ topup: string; tx: string; hash: string; cents: number }>(
    'ben',
    'POST',
    '/v1/usdc/topup',
    { micro: 2 * USDC },
  );
  const topped = await call<{ balance: number; tx: string | null }>(
    'ben',
    'POST',
    '/v1/usdc/topup/finish',
    {
      topup: t.topup,
      tx: t.tx,
      signature: players.get('ben')!.wallet.sign(t.hash),
    },
  );
  console.log(link(topped.tx));
  check('Ben’s 2 USDC bought $10,000', topped.balance === 1_000_000, `$${topped.balance / 100}`);
  check('the USDC is in Sol Motors’ wallet', (await dealerHas()) - before === BigInt(2 * USDC));

  // 3. Listed for `$` and USDC at once; Ben chooses USDC.
  const price = priceBounds(sedan).min;
  const listed = await steps<{ id: number }>('ava', '/v1/market/list', {
    car: bought.car.id,
    price,
    micro: 7 * USDC,
  });
  const market = await call<{
    listings: { id: number; price: number | null; micro: number | null }[];
  }>('ben', 'GET', '/v1/market');
  check(
    'the market shows both prices',
    market.listings.some((l) => l.id === listed.id && l.price === price && l.micro === 7 * USDC),
  );
  check(
    'the $ offer and USDC listing are on chain',
    (await near.isOffered(token)) && Boolean(await near.carListing(token)),
  );
  const avaUsdc = await near.usdcBalance(ava.near);
  const cutBefore = await dealerHas();
  const sold = await steps<{ tx: string | null }>('ben', '/v1/market/buy-usdc', { id: listed.id });
  console.log(link(sold.tx));
  check('the car is in Ben’s wallet', (await owner(token)) === ben.near);
  const paidAva = (await near.usdcBalance(ava.near)) - avaUsdc;
  check('Ava was paid 95%', paidAva === BigInt(6.65 * USDC), `+${Number(paidAva) / USDC} USDC`);
  // The cut arrives a block or two after the sale.
  let cut = 0n;
  for (let i = 0; i < 6 && cut === 0n; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    cut = (await dealerHas()) - cutBefore;
  }
  check('Sol Motors got its 5% cut', cut === BigInt(0.35 * USDC), `+${Number(cut) / USDC} USDC`);
  const benGarage = await call<{ cars: { id: number }[] }>('ben', 'GET', '/v1/garage');
  check(
    'Ben’s garage has it',
    benGarage.cars.some((c) => c.id === bought.car.id),
  );

  // 4. Ben sells it for `$` only; the game hands it over on chain.
  const resale = await steps<{ id: number }>('ben', '/v1/market/list', {
    car: bought.car.id,
    price,
  });
  const avaBefore = await dollars(ava.id);
  await call('ava', 'POST', '/v1/market/buy', { id: resale.id });
  check('the $ sale moved the car back to Ava on chain', (await owner(token)) === ava.near);
  check('Ava paid in $', avaBefore - (await dollars(ava.id)) === price, `-$${price / 100}`);

  // 5. Sent to a wallet outside the game: it leaves her garage.
  const away = near.accountOf('shopper');
  const sent = await steps<{ tx: string | null }>('ava', '/v1/garage/send', {
    car: bought.car.id,
    to: away,
  });
  console.log(link(sent.tx));
  check('it’s in the other wallet on chain', (await owner(token)) === away);
  await syncCars(cars, 0);
  const left = await call<{ cars: { id: number }[] }>('ava', 'GET', '/v1/garage');
  check('and gone from every garage', !left.cars.some((c) => c.id === bought.car.id));

  const page = await call<{ businesses: { name: string; wallet: { balance: string } | null }[] }>(
    'ava',
    'GET',
    '/v1/economy',
  );
  const motors = page.businesses.find((b) => b.name === DEALERSHIP.name);
  check(
    'the economy page reads Sol Motors from the chain',
    Boolean(motors?.wallet),
    motors?.wallet?.balance,
  );
  check('no alerts', alerts.length === 0, alerts.join(' | '));
} catch (e) {
  failures += 1;
  console.error(e);
} finally {
  await setLocks(hourNs);
  console.log('locks back to', CAR_ASSETS.lockHours.testnet, 'h');
}
console.log(failures === 0 ? '\nAll good.' : `\n${failures} failed.`);

if (process.env.KEEP) {
  await app.listen({ port: 7411, host: '127.0.0.1' });
  console.log('API up on http://127.0.0.1:7411');
} else {
  await app.close();
  await db.end();
  process.exit(failures === 0 ? 0 : 1);
}
