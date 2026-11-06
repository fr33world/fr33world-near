/**
 * Proves the money loop on the real chain: `node --env-file=../../.env src/smoke.ts`.
 * A test shopper buys from the Market, the Market pays its supplier and a delivery worker, and
 * the things that must fail do. Needs NEAR_ROOT_KEY and NEAR_OPERATOR_KEY. Testnet only.
 */
import { randomUUID } from 'node:crypto';
import { Account, KeyPair, type KeyPairString, nearToYocto, teraToGas } from 'near-api-js';
import { economyFromEnv, prepareSpend, submitSigned } from './near.ts';

const e = economyFromEnv();
if (e.cfg.network !== 'testnet') throw new Error('testnet only');
const provider = e.rpc();
const rootKey = process.env.NEAR_ROOT_KEY as KeyPairString;
const root = new Account(e.cfg.root, provider, rootKey);
const rootPublic = KeyPair.fromString(rootKey).getPublicKey().toString();
const market = e.accountOf('soles-market');
const wholesale = e.accountOf('harbor-wholesale');
const shopperId = e.accountOf('shopper');
const FAUCET = 'v2.faucet.nonofficial.testnet';
const id = (p: string) => `${p}-${randomUUID().slice(0, 12)}`;
let failures = 0;

const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
};
async function refused(name: string, run: () => Promise<unknown>, why: string) {
  try {
    await run();
    check(name, false, '(it went through!)');
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    check(name, text.includes(why), text.includes(why) ? `refused: ${why}` : text.slice(0, 160));
  }
}

async function exists(account: string) {
  try {
    await new Account(account, provider).getState();
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(shopperId)))
  await root.createSubAccount({
    accountOrPrefix: 'shopper',
    publicKey: rootPublic,
    nearToTransfer: nearToYocto('0.3'),
  });
const shopper = new Account(shopperId, provider, rootKey);
await e.registerUsdc(shopperId);
if ((await e.usdcBalance(shopperId)) < 20_000_000n) {
  await shopper.callFunction({
    contractId: FAUCET,
    methodName: 'ft_request_funds',
    args: { ft_contract_id: e.cfg.usdc, receiver_id: shopperId, amount: '100000000' },
    gas: teraToGas('100'),
  });
}
const held = await e.usdcBalance(shopperId);
check('the faucet gave test USDC', held >= 20_000_000n, `${Number(held) / 1e6} USDC`);

await e.sync(market);
const before = BigInt((await e.summary(market)).balance);
const sale = id('s');
await shopper.callFunction({
  contractId: e.cfg.usdc,
  methodName: 'ft_transfer_call',
  args: { receiver_id: market, amount: '12000000', msg: sale },
  deposit: 1n,
  gas: teraToGas('70'),
});
check('a sale reached the Market', (await e.getSale(market, sale)) === '12000000');
const after = BigInt((await e.summary(market)).balance);
check('the Market banked it', after - before === 12_000_000n);

const order = id('o');
const paid = await e.paySupplier(market, order, wholesale, 2_000_000);
const got = await e.getOrder(market, order);
check('the Market paid its supplier', got?.status === 'paid', paid.tx);

await refused(
  'the same order can’t pay twice',
  () => e.paySupplier(market, order, wholesale, 2_000_000),
  'order already exists',
);
await refused(
  'an unapproved supplier can’t be paid',
  () => e.paySupplier(market, id('o'), shopperId, 1_000_000),
  'supplier is not approved',
);
await refused(
  'the per-payment limit holds',
  () => e.paySupplier(market, id('o'), wholesale, 11_000_000),
  'over the per-payment limit',
);
await refused(
  'a stranger can’t pay from the wallet',
  () =>
    shopper.callFunction({
      contractId: market,
      methodName: 'pay_supplier',
      args: { order_id: id('o'), to: shopperId, amount: '1000000' },
      gas: teraToGas('60'),
    }),
  'operator only',
);

const job = id('j');
await e.postJob(market, job, 500_000);
check('a job holds money', (await e.getJob(market, job))?.status === 'open');
await e.assignJob(market, job, shopperId);
const b0 = await e.usdcBalance(shopperId);
await e.releaseJob(market, job);
const b1 = await e.usdcBalance(shopperId);
check('the worker got paid', b1 - b0 === 500_000n, `+${Number(b1 - b0) / 1e6} USDC`);
check('the job is paid on chain', (await e.getJob(market, job))?.status === 'paid');
await refused('a job can’t pay twice', () => e.releaseJob(market, job), 'job is not assigned');

// A player's own wallet, as Privy would sign it: an implicit account and a raw hash.
const pair = KeyPair.fromRandom('ed25519');
const implicit = Buffer.from(pair.getPublicKey().data).toString('hex');
await e.welcomePlayer(implicit);
await shopper.callFunction({
  contractId: e.cfg.usdc,
  methodName: 'ft_transfer',
  args: { receiver_id: implicit, amount: '3000000' },
  deposit: 1n,
  gas: teraToGas('30'),
});
check('a new player holds USDC', (await e.usdcBalance(implicit)) === 3_000_000n);
const pSale = id('s');
const prepared = await prepareSpend(e, implicit, {
  method: 'ft_transfer_call',
  receiver: market,
  amount: 1_000_000,
  msg: pSale,
});
const signature = pair.sign(Buffer.from(prepared.hash.slice(2), 'hex')).signature;
await submitSigned(e, implicit, prepared.tx, Buffer.from(signature).toString('hex'));
check('a player’s signed purchase landed', (await e.getSale(market, pSale)) === '1000000');
check('it left the player’s wallet', (await e.usdcBalance(implicit)) === 2_000_000n);

for (const w of [market, wholesale]) {
  await e.sync(w);
  const s = await e.summary(w);
  const onToken = await e.usdcBalance(w);
  check(
    `${w.split('.')[0]}’s books match the token`,
    BigInt(s.balance) === onToken,
    `${Number(s.balance) / 1e6} of ${Number(onToken) / 1e6} USDC`,
  );
}
const seller = await e.summary(wholesale);
const sellerBefore = BigInt(seller.balance);
const hop = id('o');
await e.paySupplier(market, hop, wholesale, 1_000_000);
check(
  'a supplier’s wallet can spend what it was paid',
  BigInt((await e.summary(wholesale)).balance) - sellerBefore === 1_000_000n,
);
console.log(failures === 0 ? '\nAll good.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
