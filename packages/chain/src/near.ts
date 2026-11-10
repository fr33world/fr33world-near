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
import { createHash } from 'node:crypto';
import {
  Account,
  actions,
  baseEncode,
  decodeTransaction,
  encodeTransaction,
  FailoverRpcProvider,
  JsonRpcProvider,
  type KeyPairString,
  KeyType,
  nearToYocto,
  Signature,
  SignedTransaction,
  teraToGas,
} from 'near-api-js';

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
/** A second endpoint: a public RPC resets connections now and then. */
const BACKUP_RPC = {
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
};

/** The network's RPC with a fallback. */
export function nearProvider(cfg: NearConfig): FailoverRpcProvider {
  return new FailoverRpcProvider([
    new JsonRpcProvider({ url: cfg.rpcUrl }),
    new JsonRpcProvider({ url: BACKUP_RPC[cfg.network] }),
  ]);
}

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

const GAS = teraToGas('120');
const YOCTO = 1n;
/** What the USDC contract charges to register an account (0.00125 NEAR). */
const REGISTER = 1_250_000_000_000_000_000_000n;
/**
 * A new player's gas money, paid by the game. NEAR wants the whole prepaid gas up front and
 * refunds what's unused, so this must cover the biggest call; a send really costs far less.
 */
const PLAYER_GAS = '0.08';

export class NearEconomy {
  readonly cfg: NearConfig;
  private readonly provider: FailoverRpcProvider;
  private readonly operator: Account | null;
  /** One at a time: an access key's nonce can't take two transactions at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cfg: NearConfig, operatorKey?: string) {
    this.cfg = cfg;
    this.provider = nearProvider(cfg);
    this.operator = operatorKey
      ? new Account(cfg.operator, this.provider, operatorKey as KeyPairString)
      : null;
  }

  rpc(): FailoverRpcProvider {
    return this.provider;
  }

  /** What the wallet screen tells a player: which token, and where to see their account. */
  walletLinks(account: string): { token: string; explorer: string } {
    return { token: this.cfg.usdc, explorer: nearblocks(this.cfg, 'address', account) };
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
    // Latest state: a write just confirmed must be visible to the next read.
    return this.provider.callFunction({
      contractId,
      method,
      args,
      blockQuery: { finality: 'optimistic' },
    }) as Promise<T>;
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

  /** Counts USDC sent to a wallet by a plain transfer. */
  sync(wallet: string): Promise<Sent> {
    return this.call(wallet, 'sync', {});
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

  /** Brings a new player's account to life with gas money, and lets it hold USDC. */
  async welcomePlayer(account: string): Promise<void> {
    const op = this.operator;
    if (!op) throw new Error('no NEAR_OPERATOR_KEY');
    const run = () => op.transfer({ receiverId: account, amount: nearToYocto(PLAYER_GAS) });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
    await this.registerUsdc(account);
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

/** A NEAR implicit account is its own public key in hex: the key that signs for it. */
export function implicitPublicKey(account: string): string {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('not an implicit account');
  return `ed25519:${baseEncode(Buffer.from(account, 'hex'))}`;
}

export interface Prepared {
  /** The borsh transaction, base64: comes back with the signature. */
  tx: string;
  /** sha256 of the transaction, 0x hex: what the player's wallet signs. */
  hash: `0x${string}`;
}

/** What a player may sign through the game: USDC only, these two methods, nothing else. */
export interface PlayerSpend {
  method: 'ft_transfer' | 'ft_transfer_call';
  receiver: string;
  amount: number;
  msg?: string;
}

/** Builds a USDC transfer for a player's own wallet to sign. The game can't sign it for them. */
export async function prepareSpend(
  e: NearEconomy,
  account: string,
  spend: PlayerSpend,
): Promise<Prepared> {
  const provider = e.rpc();
  const publicKey = implicitPublicKey(account);
  const tx = await new Account(account, provider).createTransaction({
    receiverId: e.cfg.usdc,
    publicKey,
    actions: [
      actions.functionCall(
        spend.method,
        {
          receiver_id: spend.receiver,
          amount: String(spend.amount),
          ...(spend.msg === undefined ? {} : { msg: spend.msg }),
        },
        teraToGas(spend.method === 'ft_transfer' ? '20' : '70'),
        YOCTO,
      ),
    ],
  });
  const bytes = encodeTransaction(tx);
  return {
    tx: Buffer.from(bytes).toString('base64'),
    hash: `0x${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/** Adds the player's signature and sends. The transaction must be the one for this account. */
export async function submitSigned(
  e: NearEconomy,
  account: string,
  tx: string,
  signature: string,
): Promise<Sent> {
  const transaction = decodeTransaction(Buffer.from(tx, 'base64'));
  if (transaction.signerId !== account) throw new Error('not this player’s transaction');
  if (transaction.receiverId !== e.cfg.usdc) throw new Error('not a USDC transaction');
  const data = Buffer.from(signature.replace(/^0x/, ''), 'hex');
  if (data.length !== 64) throw new Error('bad signature');
  const signed = new SignedTransaction({
    transaction,
    signature: new Signature({ keyType: KeyType.ED25519, data }),
  });
  const r = await e.rpc().sendTransactionUntil(signed, 'EXECUTED_OPTIMISTIC');
  const status = r.status as { Failure?: unknown };
  if (status.Failure) throw new Error('the transaction failed');
  return { tx: r.transaction.hash };
}

/** The economy from the environment; reads work without a key, writes need NEAR_OPERATOR_KEY. */
export function economyFromEnv(env: Record<string, string | undefined> = process.env) {
  return new NearEconomy(nearConfig(env), env.NEAR_OPERATOR_KEY);
}
