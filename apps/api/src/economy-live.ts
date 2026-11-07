/**
 * One player's whole story, through the real API routes and the real testnet:
 *   pnpm --filter @fr33world/api economy:live
 * Links a wallet, buys a Hot Meal with USDC, watches Sunny's reorder and pay its supplier, takes
 * the delivery, finishes it the way the world server does, is paid on chain, and sends USDC on.
 * Only Privy is stood in for: a local key signs the same hash Privy would. The database is a
 * scratch schema in fr33world_test. Needs NEAR_ROOT_KEY and NEAR_OPERATOR_KEY. Testnet only.
 * With KEEP=1 the API stays up on port 7411 afterwards, to look at the economy page.
 */
import { economyFromEnv, nearblocks, prepareSpend, submitSigned } from '@fr33world/chain';
import { fundFromShopper, testWallet } from '@fr33world/chain/testkit';
import { BUSINESSES, GOODS, unitPrice } from '@fr33world/shared';
import { internalKey } from '@fr33world/auth';
import { buildApp } from './app.ts';
import { armsOf } from './armory.ts';
import { tick } from './business.ts';
import { testDb } from './test-db.ts';

const near = economyFromEnv();
if (near.cfg.network !== 'testnet') throw new Error('testnet only');
const rootKey = process.env.NEAR_ROOT_KEY;
if (!rootKey || !process.env.NEAR_OPERATOR_KEY) throw new Error('needs the testnet keys in .env');

const chain = Object.assign(near, {
  prepare: (account: string, spend: Parameters<typeof prepareSpend>[2]) =>
    prepareSpend(near, account, spend),
  submit: (account: string, tx: string, signature: string) =>
    submitSigned(near, account, tx, signature),
});
const db = await testDb('live');
const wallet = testWallet();
const privy = 'did:privy:live-run';
const secret = 'live-run-ticket-secret-0123456789abcdef';
const alerts: string[] = [];
const economy = { db, chain, alert: (t: string) => alerts.push(t) };
const app = buildApp({
  db,
  verify: () => Promise.resolve(privy),
  isGuest: () => Promise.resolve(false),
  ticketSecret: secret,
  corsOrigins: ['http://localhost:5173', 'http://localhost:5199'],
  economy,
  usdc: { db, chain, walletOf: () => Promise.resolve(wallet.account) },
});

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
};
const tx = (hash?: string | null) => (hash ? nearblocks(near.cfg, 'txns', hash) : '');

async function call<T>(method: 'GET' | 'POST', url: string, payload?: object, token = 'player') {
  const r = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.statusCode >= 400) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
  return r.json<T>();
}

const made = await db.query<{ id: string }>(
  "insert into accounts (privy_user_id, display_name, is_guest) values ($1, 'Live', false) returning id",
  [privy],
);
const account = made.rows[0]!.id;
// Past the job rules' level and character age, which tests cover on their own.
await db.query(
  `insert into characters (account_id, name, age, appearance, xp, created_at)
   values ($1, 'Live Run', 25, 0, 100000, now() - interval '3 days')`,
  [account],
);

await tick(economy, 0);
const linked = await call<{ near: string }>('POST', '/v1/usdc/link');
check('the wallet is linked', linked.near === wallet.account, linked.near.slice(0, 12));
await fundFromShopper(near, rootKey, wallet.account, 3_000_000);
const card = await call<{ micro: number }>('GET', '/v1/usdc');
check('the card shows the chain’s balance', card.micro === 3_000_000, `${card.micro / 1e6} USDC`);

const market = BUSINESSES.find((b) => b.id === 'market')!;
const meal = GOODS.find((g) => g.id === 'meal')!;
const price = unitPrice(market, meal);
const shelf = await call<{ id: string; micro: number; stock: number }[]>('GET', '/v1/market/shelf');
check('the shelf has a Hot Meal', (shelf.find((g) => g.id === 'meal')?.stock ?? 0) > 0);

const sale = await call<{ sale: string; micro: number; tx: string; hash: string }>(
  'POST',
  '/v1/usdc/sale',
  { good: 'meal' },
);
check('the sale is at the listed price', sale.micro === price, `${price / 1e6} USDC`);
const paid = await call<{ tx: string | null }>('POST', '/v1/usdc/sale/finish', {
  sale: sale.sale,
  tx: sale.tx,
  signature: wallet.sign(sale.hash),
});
console.log(`     ${tx(paid.tx)}`);
const onChain = await near.getSale(near.accountOf(market.account), sale.sale);
check('the chain has the sale', onChain === String(price));
check('the meal is in the bag', (await armsOf(db, account)).care?.meal === 1);
check(
  'the money left the player',
  (await near.usdcBalance(wallet.account)) === BigInt(3_000_000 - price),
);

// A quiet week at Sunny's in one line: the shelf runs low, so the next tick reorders.
await db.query("update business_stock set qty = 2 where business = 'market' and good = 'meal'");
const ticked = await tick(economy, 0);
check('Sunny’s reordered and paid on chain', ticked.paid >= 1, JSON.stringify(ticked));
check('no mismatch with the chain', ticked.mismatches === 0);
const orders = await db.query<{ tx: string | null; amount: string }>(
  "select tx, amount from business_orders where status = 'paid' order by created_at desc limit 1",
);
console.log(`     ${tx(orders.rows[0]?.tx)}`);

const open = await db.query<{ id: string; amount: string; business: string }>(
  "select id, amount, business from business_jobs where status = 'open' limit 1",
);
const job = open.rows[0];
check('a delivery job is open', Boolean(job));
if (!job) process.exit(1);
const biz = BUSINESSES.find((b) => b.id === job.business)!;
await call('POST', '/v1/usdc/job', { job: job.id });
const held = await near.getJob(near.accountOf(biz.account), job.id);
check('the job is fixed to the player on chain', held?.worker === wallet.account, held?.status);

const before = await near.usdcBalance(wallet.account);
await call('POST', '/v1/internal/haul/finish', { account }, internalKey(secret));
const after = await near.usdcBalance(wallet.account);
check(
  'the delivery paid the player on chain',
  after - before === BigInt(job.amount),
  `+${Number(job.amount) / 1e6} USDC`,
);
const done = await db.query<{ status: string; tx: string | null }>(
  'select status, tx from business_jobs where id = $1',
  [job.id],
);
check('the job is closed', done.rows[0]?.status === 'paid');
console.log(`     ${tx(done.rows[0]?.tx)}`);

const to = near.accountOf('shopper');
const send = await call<{ tx: string; hash: string }>('POST', '/v1/usdc/send', {
  to,
  micro: 500_000,
});
const sent = await call<{ tx: string }>('POST', '/v1/usdc/send/finish', {
  tx: send.tx,
  signature: wallet.sign(send.hash),
});
console.log(`     ${tx(sent.tx)}`);
check('the player sent USDC on', (await near.usdcBalance(wallet.account)) === after - 500_000n);

const page = await call<{
  businesses: { name: string; wallet: { balance: string; reserved: string } | null }[];
  decisions: unknown[];
}>('GET', '/v1/economy');
for (const b of page.businesses) {
  const real = b.wallet ? Number(b.wallet.balance) / 1e6 : null;
  check(`the economy page reads ${b.name} from the chain`, real !== null, `${real} USDC`);
}
check('no alerts', alerts.length === 0, alerts.join(' | '));
console.log(failures === 0 ? '\nAll good.' : `\n${failures} failed.`);

if (process.env.KEEP) {
  await app.listen({ port: 7411, host: '127.0.0.1' });
  console.log('API up on http://127.0.0.1:7411');
} else {
  await app.close();
  await db.end();
  process.exit(failures === 0 ? 0 : 1);
}
