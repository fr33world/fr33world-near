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
import { CAR_ASSETS } from '@fr33world/shared';
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

/** A car on the cars contract (NEP-171), as `nft_token` and `nft_tokens` return it. */
export interface ChainCar {
  token_id: string;
  owner_id: string;
  metadata?: { title?: string | null; extra?: string | null } | null;
}

/** A car for sale for USDC on the cars contract. */
export interface ChainListing {
  seller: string;
  price: string;
  listed_at: number;
}

/** What a car's title deed says in a wallet. */
export interface CarMetadata {
  title: string;
  description: string;
  media: string | null;
  extra: string;
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
/** Below this, a player's gas money is topped up before they sign for a car. */
const LOW_GAS = '0.03';
/** The public community faucet for testnet tokens, including `usdc.fakes.testnet`. */
const TEST_FAUCET = 'v2.faucet.nonofficial.testnet';

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

  // ---- Cars (contracts/cars) ------------------------------------------------------------

  /** The cars contract's account. */
  carsAccount(): string {
    return this.accountOf(CAR_ASSETS.account);
  }

  /** A link to a car's account or a transaction on NearBlocks. */
  explorer(kind: 'address' | 'txns', id: string): string {
    return nearblocks(this.cfg, kind, id);
  }

  /** Mints a car to its owner's wallet. The contract refuses a token id it already has. */
  mintCar(tokenId: string, owner: string, metadata: CarMetadata): Promise<Sent> {
    return this.call(this.carsAccount(), 'mint_car', {
      token_id: tokenId,
      owner,
      metadata: { ...metadata, issued_at: String(Date.now()) },
    });
  }

  /** Hands a car its owner offered for `$` to the player who paid. */
  gameTransfer(tokenId: string, receiver: string): Promise<Sent> {
    return this.call(this.carsAccount(), 'game_transfer', {
      token_id: tokenId,
      receiver_id: receiver,
    });
  }

  carToken(tokenId: string): Promise<ChainCar | null> {
    return this.view(this.carsAccount(), 'nft_token', { token_id: tokenId });
  }

  carTokens(from: number, limit: number): Promise<ChainCar[]> {
    return this.view(this.carsAccount(), 'nft_tokens', { from_index: String(from), limit });
  }

  carListing(tokenId: string): Promise<ChainListing | null> {
    return this.view(this.carsAccount(), 'get_listing', { token_id: tokenId });
  }

  async carListings(): Promise<[string, ChainListing][]> {
    const all: [string, ChainListing][] = [];
    for (let from = 0; ; from += 100) {
      const page = await this.view<[string, ChainListing][]>(this.carsAccount(), 'listings', {
        from_index: from,
        limit: 100,
      });
      all.push(...page);
      if (page.length < 100) return all;
    }
  }

  isOffered(tokenId: string): Promise<boolean> {
    return this.view(this.carsAccount(), 'is_offered', { token_id: tokenId });
  }

  /** When a car may next be sent or listed, as a time in ms; 0 if it's free now. */
  async carLockedUntil(tokenId: string): Promise<number> {
    const ns = await this.view<number>(this.carsAccount(), 'locked_until', { token_id: tokenId });
    return Math.ceil(Number(ns) / 1e6);
  }

  /** Tops a player's gas money back up when it runs low, so they can always sign for a car. */
  async ensureGas(account: string): Promise<void> {
    const op = this.operator;
    if (!op) throw new Error('no NEAR_OPERATOR_KEY');
    const state = await new Account(account, this.provider).getState().catch(() => null);
    const has = state ? BigInt(String(state.balance.available)) : 0n;
    if (has >= nearToYocto(LOW_GAS)) return;
    const run = () => op.transfer({ receiverId: account, amount: nearToYocto(PLAYER_GAS) });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
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

  /**
   * Testnet only: asks the public community faucet to send test USDC straight to a player's
   * account. The USDC is the faucet's, not the game's; the caller enforces the limits.
   */
  async requestTestUsdc(account: string, micro: number): Promise<Sent> {
    if (this.cfg.network !== 'testnet') throw new Error('test USDC is only on testnet');
    await this.registerUsdc(account);
    return this.call(TEST_FAUCET, 'ft_request_funds', {
      ft_contract_id: this.cfg.usdc,
      receiver_id: account,
      amount: String(micro),
    });
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

/** What a player may sign through the game: these USDC methods and these car methods only. */
export interface PlayerSpend {
  method: 'ft_transfer' | 'ft_transfer_call';
  receiver: string;
  amount: number;
  msg?: string;
}

export type PlayerCarCall =
  | { method: 'list_car'; tokenId: string; price: number }
  | { method: 'delist_car' | 'offer_to_game' | 'withdraw_offer'; tokenId: string }
  | { method: 'nft_transfer'; tokenId: string; receiver: string }
  | { method: 'claim' };

async function preparePlayer(
  e: NearEconomy,
  account: string,
  receiverId: string,
  method: string,
  args: Record<string, unknown>,
  tera: `${number}`,
  deposit: bigint,
): Promise<Prepared> {
  const provider = e.rpc();
  const publicKey = implicitPublicKey(account);
  const tx = await new Account(account, provider).createTransaction({
    receiverId,
    publicKey,
    actions: [actions.functionCall(method, args, teraToGas(tera), deposit)],
  });
  const bytes = encodeTransaction(tx);
  return {
    tx: Buffer.from(bytes).toString('base64'),
    hash: `0x${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/** Builds a USDC transfer for a player's own wallet to sign. The game can't sign it for them. */
export function prepareSpend(
  e: NearEconomy,
  account: string,
  spend: PlayerSpend,
): Promise<Prepared> {
  // Buying a car pays out to the seller and the dealership in the same call: more gas.
  const tera =
    spend.method === 'ft_transfer' ? '20' : spend.receiver === e.carsAccount() ? '200' : '70';
  return preparePlayer(
    e,
    account,
    e.cfg.usdc,
    spend.method,
    {
      receiver_id: spend.receiver,
      amount: String(spend.amount),
      ...(spend.msg === undefined ? {} : { msg: spend.msg }),
    },
    tera,
    YOCTO,
  );
}

/** Builds a call on the cars contract for a player's own wallet to sign: their car, their key. */
export function prepareCarCall(
  e: NearEconomy,
  account: string,
  c: PlayerCarCall,
): Promise<Prepared> {
  const cars = e.carsAccount();
  switch (c.method) {
    case 'list_car':
      return preparePlayer(
        e,
        account,
        cars,
        c.method,
        { token_id: c.tokenId, price: String(c.price) },
        '20',
        YOCTO,
      );
    case 'nft_transfer':
      return preparePlayer(
        e,
        account,
        cars,
        c.method,
        { token_id: c.tokenId, receiver_id: c.receiver },
        '30',
        YOCTO,
      );
    case 'claim':
      return preparePlayer(e, account, cars, c.method, {}, '60', 0n);
    default:
      return preparePlayer(e, account, cars, c.method, { token_id: c.tokenId }, '20', YOCTO);
  }
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
  if (transaction.receiverId !== e.cfg.usdc && transaction.receiverId !== e.carsAccount())
    throw new Error('not a USDC or car transaction');
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
