/**
 * Which Solana cluster the game talks to (decision D-09: Devnet now, Mainnet by configuration
 * plus a go-live checklist). Environment:
 *   SOLANA_CLUSTER        devnet | mainnet-beta (default devnet)
 *   SOLANA_RPC_URL        RPC endpoint (default: the cluster's public endpoint)
 *   CHAIN_ALLOW_MAINNET   must be "yes" to use mainnet-beta, so a stray variable can't spend
 *                         real SOL
 */

export type Cluster = 'devnet' | 'mainnet-beta';

export interface ChainConfig {
  cluster: Cluster;
  rpcUrl: string;
}

const PUBLIC_RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

export function chainConfig(env: Record<string, string | undefined> = process.env): ChainConfig {
  const cluster = (env.SOLANA_CLUSTER ?? 'devnet') as Cluster;
  if (!(cluster in PUBLIC_RPC)) throw new Error(`unknown SOLANA_CLUSTER ${cluster}`);
  if (cluster === 'mainnet-beta' && env.CHAIN_ALLOW_MAINNET !== 'yes') {
    throw new Error('mainnet-beta needs CHAIN_ALLOW_MAINNET=yes (see the go-live checklist)');
  }
  return { cluster, rpcUrl: env.SOLANA_RPC_URL || PUBLIC_RPC[cluster] };
}

/** A Solana Explorer link for an account or transaction on the configured cluster. */
export function explorerUrl(cfg: ChainConfig, kind: 'address' | 'tx', id: string): string {
  const suffix = cfg.cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://explorer.solana.com/${kind}/${id}${suffix}`;
}
