/**
 * A stand-in for a player's Privy wallet, for runs against the real testnet: a NEAR implicit
 * account whose key lives here, signing the same raw hash Privy signs. Funded from the `shopper`
 * test account that `smoke.ts` keeps, so it needs NEAR_ROOT_KEY. Testnet only.
 */
import { Account, KeyPair, type KeyPairString, teraToGas } from 'near-api-js';
import type { NearEconomy } from './near.ts';

const FAUCET = 'v2.faucet.nonofficial.testnet';

export interface TestWallet {
  account: string;
  /** What Privy's raw sign gives the client: the signature of a 0x hash, as hex. */
  sign(hash: string): string;
}

export function testWallet(): TestWallet {
  const pair = KeyPair.fromRandom('ed25519');
  return {
    account: Buffer.from(pair.getPublicKey().data).toString('hex'),
    sign: (hash) =>
      Buffer.from(pair.sign(Buffer.from(hash.slice(2), 'hex')).signature).toString('hex'),
  };
}

/** Sends test USDC from the `shopper` account, topping it up at the faucet if it's short. */
export async function fundFromShopper(
  e: NearEconomy,
  rootKey: string,
  to: string,
  micro: number,
): Promise<void> {
  if (e.cfg.network !== 'testnet') throw new Error('testnet only');
  const id = e.accountOf('shopper');
  const shopper = new Account(id, e.rpc(), rootKey as KeyPairString);
  if ((await e.usdcBalance(id)) < BigInt(micro))
    await shopper.callFunction({
      contractId: FAUCET,
      methodName: 'ft_request_funds',
      args: { ft_contract_id: e.cfg.usdc, receiver_id: id, amount: '100000000' },
      gas: teraToGas('100'),
    });
  await shopper.callFunction({
    contractId: e.cfg.usdc,
    methodName: 'ft_transfer',
    args: { receiver_id: to, amount: String(micro) },
    deposit: 1n,
    gas: teraToGas('30'),
  });
}

/** Testnet runs: the admin sets how long new and sold cars stay locked, in nanoseconds. */
export async function setCarLocks(e: NearEconomy, rootKey: string, ns: number): Promise<void> {
  if (e.cfg.network !== 'testnet') throw new Error('testnet only');
  const admin = new Account(e.cfg.root, e.rpc(), rootKey as KeyPairString);
  await admin.callFunction({
    contractId: e.carsAccount(),
    methodName: 'set_locks',
    args: { after_mint_ns: ns, after_sale_ns: ns },
  });
}
