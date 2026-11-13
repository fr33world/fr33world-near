/**
 * Sets up the economy on NEAR, safe to run again: the operator account, one account and wallet
 * contract per business (shared BUSINESSES, then the dealership, shared DEALERSHIP), each
 * registered to hold USDC, and the cars contract (contracts/cars, shared CAR_ASSETS).
 *
 *   node --env-file=../../.env src/deploy.ts          create what's missing
 *   node --env-file=../../.env src/deploy.ts --upgrade  new code on existing wallets, state kept
 *   node --env-file=../../.env src/deploy.ts --reset    testnet: remake the wallets from nothing
 *   node --env-file=../../.env src/deploy.ts --lock   also remove the business accounts' keys,
 *                                                     so their code can never be changed
 *
 * Needs NEAR_ROOT_KEY. A new operator key goes into .env (git-ignored), never to the screen.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { BUSINESSES, CAR_ASSETS, DEALERSHIP } from '@fr33world/shared';
import { Account, KeyPair, type KeyPairString, nearToYocto } from 'near-api-js';
import { nearConfig, nearProvider } from './near.ts';

const WASM = new URL(
  '../../../contracts/business-wallet/target/near/business_wallet.wasm',
  import.meta.url,
);
const CARS_WASM = new URL('../../../contracts/cars/target/near/cars.wasm', import.meta.url);
const ENV = new URL('../../../.env', import.meta.url);
const cfg = nearConfig();
const provider = nearProvider(cfg);
const rootKey = process.env.NEAR_ROOT_KEY as KeyPairString | undefined;
if (!rootKey) throw new Error('NEAR_ROOT_KEY is not set');
const root = new Account(cfg.root, provider, rootKey);
const rootPublic = KeyPair.fromString(rootKey).getPublicKey().toString();

async function exists(id: string) {
  try {
    await new Account(id, provider).getState();
    return true;
  } catch {
    return false;
  }
}

async function makeOperator() {
  if (await exists(cfg.operator)) return console.log(`have ${cfg.operator}`);
  if (process.env.NEAR_OPERATOR_KEY) throw new Error('operator key set but no operator account');
  const key = KeyPair.fromRandom('ed25519');
  await root.createSubAccount({
    accountOrPrefix: 'operator',
    publicKey: key.getPublicKey().toString(),
    nearToTransfer: nearToYocto('1'),
  });
  appendFileSync(ENV, `NEAR_OPERATOR_KEY=${key.toString()}\n`);
  process.env.NEAR_OPERATOR_KEY = key.toString();
  console.log(`made ${cfg.operator}, key saved to .env`);
}

interface WalletSpec {
  account: string;
  name: string;
  perPayment: number;
  perDay: number;
  /** Full account ids it may pay. */
  suppliers: string[];
}

async function makeBusiness(b: WalletSpec, code: Uint8Array) {
  const id = `${b.account}.${cfg.root}`;
  if (process.argv.includes('--reset') && (await exists(id))) {
    if (cfg.network !== 'testnet') throw new Error('--reset is for testnet');
    await new Account(id, provider, rootKey).deleteAccount(cfg.root);
    console.log(`removed ${id}`);
  }
  if (!(await exists(id))) {
    await root.createSubAccount({
      accountOrPrefix: b.account,
      publicKey: rootPublic,
      nearToTransfer: nearToYocto('2.7'),
    });
    console.log(`made ${id}`);
  }
  const wallet = new Account(id, provider, rootKey);
  const state = await wallet.getState();
  if (/^1+$/.test(String(state.codeHash))) {
    // The contract's storage needs about 2.4 NEAR held on the account.
    const need = nearToYocto('2.7');
    const has = BigInt(String(state.balance.total));
    if (has < need) await root.transfer({ receiverId: id, amount: need - has });
    await wallet.deployContract(code);
    await wallet.callFunction({
      contractId: id,
      methodName: 'new',
      args: {
        name: b.name,
        usdc: cfg.usdc,
        admin: cfg.root,
        operator: cfg.operator,
        per_payment: String(b.perPayment),
        per_day: String(b.perDay),
        suppliers: b.suppliers,
      },
    });
    console.log(`deployed ${id}`);
  } else if (process.argv.includes('--upgrade')) {
    await wallet.deployContract(code);
    console.log(`upgraded ${id}`);
  }
  const registered = await provider.callFunction({
    contractId: cfg.usdc,
    method: 'storage_balance_of',
    args: { account_id: id },
  });
  if (!registered) {
    await root.callFunction({
      contractId: cfg.usdc,
      methodName: 'storage_deposit',
      args: { account_id: id, registration_only: true },
      deposit: nearToYocto('0.00125'),
    });
    console.log(`registered ${id} for USDC`);
  }
  if (process.argv.includes('--lock')) {
    await wallet.deleteKey(rootPublic);
    console.log(`locked ${id}`);
  }
}

/** The cars contract: the operator mints, the root is admin, the dealership gets the cut. */
async function makeCars(code: Uint8Array) {
  const id = `${CAR_ASSETS.account}.${cfg.root}`;
  if (process.argv.includes('--reset-cars') && (await exists(id))) {
    if (cfg.network !== 'testnet') throw new Error('--reset-cars is for testnet');
    await new Account(id, provider, rootKey).deleteAccount(cfg.root);
    console.log(`removed ${id}`);
  }
  // Its code takes most of this; the rest pays for cars and listings as they're stored.
  if (!(await exists(id))) {
    await root.createSubAccount({
      accountOrPrefix: CAR_ASSETS.account,
      publicKey: rootPublic,
      nearToTransfer: nearToYocto('4'),
    });
    console.log(`made ${id}`);
  }
  const cars = new Account(id, provider, rootKey);
  const state = await cars.getState();
  const lockNs = String(BigInt(CAR_ASSETS.lockHours[cfg.network]) * 3_600_000_000_000n);
  if (/^1+$/.test(String(state.codeHash))) {
    await cars.deployContract(code);
    await cars.callFunction({
      contractId: id,
      methodName: 'new',
      args: {
        usdc: cfg.usdc,
        admin: cfg.root,
        minter: cfg.operator,
        dealer: `${DEALERSHIP.account}.${cfg.root}`,
        fee_bps: CAR_ASSETS.feeBps,
        lock_after_mint_ns: Number(lockNs),
        lock_after_sale_ns: Number(lockNs),
        base_uri: null,
      },
    });
    console.log(`deployed ${id}`);
  } else if (process.argv.includes('--upgrade')) {
    await cars.deployContract(code);
    console.log(`upgraded ${id}`);
  }
  const registered = await provider.callFunction({
    contractId: cfg.usdc,
    method: 'storage_balance_of',
    args: { account_id: id },
  });
  if (!registered) {
    await root.callFunction({
      contractId: cfg.usdc,
      methodName: 'storage_deposit',
      args: { account_id: id, registration_only: true },
      deposit: nearToYocto('0.00125'),
    });
    console.log(`registered ${id} for USDC`);
  }
}

await makeOperator();
const code = new Uint8Array(readFileSync(WASM));
console.log(`contract: ${code.length} bytes`);
for (const b of BUSINESSES) {
  const supplier = BUSINESSES.find((s) => s.id === b.supplier);
  await makeBusiness(
    { ...b, suppliers: supplier ? [`${supplier.account}.${cfg.root}`] : [] },
    code,
  );
}
// The dealership may pay only the cars contract: buying back a listed car is its one spend.
await makeBusiness({ ...DEALERSHIP, suppliers: [`${CAR_ASSETS.account}.${cfg.root}`] }, code);
await makeCars(new Uint8Array(readFileSync(CARS_WASM)));
console.log('done');
