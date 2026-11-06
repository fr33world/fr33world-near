/**
 * The game's side of NEAR (D-41, D-43): reads and writes the business wallet contracts. The
 * worker signs as the operator, which the contract lets pay only within its limits, so nothing
 * here (or any AI behind it) can spend more than the chain allows. Every write carries an id
 * the contract refuses to repeat, so a retry after a timeout never pays twice.
 *
 * Environment:
 *   NEAR_NETWORK        testnet | mainnet (default testnet)
 *   NEAR_RPC_URL        RPC endpoint (default: the network's public endpoint)
 *   NEAR_ROOT_ACCOUNT   parent of the business accounts (default fr33world.testnet)
 *   NEAR_USDC           the USDC contract (default: the testnet faucet's test token)
 *   NEAR_OPERATOR_KEY   the operator's key, server-only
 *   CHAIN_ALLOW_MAINNET must be "yes" to use mainnet, so a stray variable can't spend real USDC
 */
import { Account, JsonRpcProvider, type KeyPairString, teraToGas } from 'near-api-js';

export interface NearConfig {
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  root: string;
  operator: string;
  usdc: string;
}

/** The test USDC testnet's faucet gives out. Circle's own testnet token has no open faucet. */
export const TEST_USDC = 'usdc.fakes.testnet';
const RPC = { testnet: 'https://test.rpc.fastnear.com', mainnet: 'https://free.rpc.fastnear.com' };

export function nearConfig(env: Record<string, string | undefined> = process.env): NearConfig {
  const network = (env.NEAR_NETWORK ?? 'testnet') as NearConfig['network'];
  if (!(network in RPC)) throw new Error(`unknown NEAR_NETWORK ${network}`);
  if (network === 'mainnet' && env.CHAIN_ALLOW_MAINNET !== 'yes')
    throw new Error('mainnet needs CHAIN_ALLOW_MAINNET=yes');
  if (network === 'mainnet' && !env.NEAR_USDC) throw new Error('mainnet needs NEAR_USDC');
  const root = env.NEAR_ROOT_ACCOUNT ?? 'fr33world.testnet';
  return {
    network,
    rpcUrl: env.NEAR_RPC_URL || RPC[network],
    root,
    operator: `operator.${root}`,
    usdc: env.NEAR_USDC ?? TEST_USDC,
  };
}

/** A link to an account or transaction on NearBlocks. */
export function nearblocks(cfg: NearConfig, kind: 'address' | 'txns', id: string): string {
  const host = cfg.network === 'testnet' ? 'testnet.nearblocks.io' : 'nearblocks.io';
  return `https://${host}/${kind}/${id}`;
}

export interface WalletSummary {
  name: string;
  usdc: string;
  admin: string;
  operator: string;
  per_payment: string;
  per_day: string;
  balance: string;
  reserved: string;
  spent_today: string;
  suppliers: string[];
}

export interface ChainOrder {
  to: string;
  amount: string;
  status: 'pending' | 'paid' | 'failed';
}

export interface ChainJob {
  amount: string;
  worker: string | null;
  status: 'open' | 'assigned' | 'releasing' | 'paid' | 'cancelled';
}

/** The transaction a write went out in. */
export interface Sent {
  tx: string;
}

const GAS = teraToGas('60');
const YOCTO = 1n;
/** What the USDC contract charges to register an account (0.00125 NEAR). */
const REGISTER = 1_250_000_000_000_000_000_000n;

export class NearEconomy {
  readonly cfg: NearConfig;
  private readonly provider: JsonRpcProvider;
  private readonly operator: Account | null;
  /** One at a time: an access key's nonce can't take two transactions at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cfg: NearConfig, operatorKey?: string) {
    this.cfg = cfg;
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.operator = operatorKey
      ? new Account(cfg.operator, this.provider, operatorKey as KeyPairString)
      : null;
  }

  /** A business's account from its short name. */
  accountOf(short: string): string {
    return `${short}.${this.cfg.root}`;
  }

  private view<T>(
    contractId: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return this.provider.callFunction({ contractId, method, args }) as Promise<T>;
  }

  private call(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
    deposit = 0n,
  ): Promise<Sent> {
    const op = this.operator;
    if (!op) throw new Error('no NEAR_OPERATOR_KEY');
    const run = async () => {
      const r = await op.callFunctionRaw({ contractId, methodName, args, deposit, gas: GAS });
      return { tx: r.transaction.hash };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  summary(wallet: string): Promise<WalletSummary> {
    return this.view(wallet, 'summary');
  }

  getOrder(wallet: string, orderId: string): Promise<ChainOrder | null> {
    return this.view(wallet, 'get_order', { order_id: orderId });
  }

  getJob(wallet: string, jobId: string): Promise<ChainJob | null> {
    return this.view(wallet, 'get_job', { job_id: jobId });
  }

  getSale(wallet: string, saleId: string): Promise<string | null> {
    return this.view(wallet, 'get_sale', { sale_id: saleId });
  }

  /** USDC an account holds at the token contract, in micro-USDC. */
  async usdcBalance(account: string): Promise<bigint> {
    return BigInt(await this.view<string>(this.cfg.usdc, 'ft_balance_of', { account_id: account }));
  }

  paySupplier(wallet: string, orderId: string, to: string, amount: number): Promise<Sent> {
    return this.call(wallet, 'pay_supplier', {
      order_id: orderId,
      to,
      amount: String(amount),
    });
  }

  postJob(wallet: string, jobId: string, amount: number): Promise<Sent> {
    return this.call(wallet, 'post_job', { job_id: jobId, amount: String(amount) });
  }

  assignJob(wallet: string, jobId: string, worker: string): Promise<Sent> {
    return this.call(wallet, 'assign_job', { job_id: jobId, worker });
  }

  releaseJob(wallet: string, jobId: string): Promise<Sent> {
    return this.call(wallet, 'release_job', { job_id: jobId });
  }

  cancelJob(wallet: string, jobId: string): Promise<Sent> {
    return this.call(wallet, 'cancel_job', { job_id: jobId });
  }

  /** Lets an account hold USDC; the game pays the small fee. Does nothing if it's registered. */
  async registerUsdc(account: string): Promise<void> {
    const had = await this.view<unknown>(this.cfg.usdc, 'storage_balance_of', {
      account_id: account,
    });
    if (had) return;
    await this.call(
      this.cfg.usdc,
      'storage_deposit',
      { account_id: account, registration_only: true },
      REGISTER,
    );
  }
}

export { YOCTO };

/** The economy from the environment; reads work without a key, writes need NEAR_OPERATOR_KEY. */
export function economyFromEnv(env: Record<string, string | undefined> = process.env) {
  return new NearEconomy(nearConfig(env), env.NEAR_OPERATOR_KEY);
}
