/**
 * The game API server. Environment:
 *   PORT                 default 7410
 *   DATABASE_URL         default postgres://localhost/fr33world_dev
 *   PRIVY_APP_ID, PRIVY_APP_SECRET   verify logins
 *   WORLD_TICKET_SECRET  signs world tickets (same value on the world server)
 *   API_CORS_ORIGINS     comma-separated browser origins (default: local dev and the
 *                        Cloudflare client)
 *   SIGNUP_BONUS_CENTS   default 500000 ($5,000)
 *   ADMIN_TOKEN          enables /v1/admin/* (Bearer token); unset = off
 *   ALERT_WEBHOOK_URL    optional: economy alerts are also posted there (Discord or Slack)
 *   CHAIN_AUTHORITY_SECRET, SOLANA_CLUSTER, SOLANA_RPC_URL   optional: car certificates on
 *                        Solana (chain.ts); unset = the queue waits
 * Applies pending migrations on start, then runs the economy's invariant monitor.
 */
import {
  assertSecret,
  privyGuestCheck,
  privyNearWallet,
  privyVerifier,
  privyWallet,
} from '@fr33world/auth';
import { economyFromEnv, prepareSpend, registryFromEnv, submitSigned } from '@fr33world/chain';
import { buildApp } from './app.ts';
import { createDb } from './db.ts';
import { migrate } from './migrate.ts';
import { reconcile, runChainQueue } from './chain.ts';
import { alert, startMonitor } from './monitor.ts';

const { PRIVY_APP_ID, PRIVY_APP_SECRET, WORLD_TICKET_SECRET } = process.env;

/** The economy on NEAR, when this server has the operator's key. */
function nearDeps() {
  if (!process.env.NEAR_OPERATOR_KEY) return {};
  const near = economyFromEnv();
  const chain = Object.assign(near, {
    prepare: (account: string, spend: Parameters<typeof prepareSpend>[2]) =>
      prepareSpend(near, account, spend),
    submit: (account: string, tx: string, signature: string) =>
      submitSigned(near, account, tx, signature),
  });
  return {
    economy: { db, chain, alert: (text: string) => void alert(db, 'economy', { text }) },
    usdc: { db, chain, walletOf: privyNearWallet(PRIVY_APP_ID!, PRIVY_APP_SECRET!) },
  };
}
if (!PRIVY_APP_ID || !PRIVY_APP_SECRET)
  throw new Error('the API needs PRIVY_APP_ID and PRIVY_APP_SECRET');
assertSecret(WORLD_TICKET_SECRET);

const db = createDb();
await migrate(db, (line) => console.log(line));
const app = buildApp({
  db,
  verify: privyVerifier(PRIVY_APP_ID, PRIVY_APP_SECRET),
  isGuest: privyGuestCheck(PRIVY_APP_ID, PRIVY_APP_SECRET),
  ticketSecret: WORLD_TICKET_SECRET,
  corsOrigins: (
    process.env.API_CORS_ORIGINS ??
    'http://localhost:5173,https://fr33worldgame.xyz,https://fr33world.fr33world-client.workers.dev'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  adminToken: process.env.ADMIN_TOKEN,
  logger: true,
  ...nearDeps(),
});
await app.listen({ port: Number(process.env.PORT ?? 7410), host: '0.0.0.0' });
startMonitor(db);

// Car certificates: the queue every 30 s, a few cars checked against the chain every 10 min.
const registry = registryFromEnv();
if (registry) {
  const chain = {
    db,
    chain: registry,
    walletOf: privyWallet(PRIVY_APP_ID, PRIVY_APP_SECRET),
    alert: (text: string) => void alert(db, 'chain', { text }),
    uri: (model: string) => `https://fr33worldgame.xyz/nft/cars/${model}.json`,
  };
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    runChainQueue(chain)
      .catch((e: unknown) => app.log.error(e, 'chain queue'))
      .finally(() => (busy = false));
  }, 30_000);
  setInterval(() => void reconcile(chain).catch(() => {}), 10 * 60_000);
  app.log.info(
    `car certificates on ${process.env.SOLANA_CLUSTER ?? 'devnet'}: ${registry.authorityAddress}`,
  );
}

process.on('unhandledRejection', (e) => app.log.error(e, 'unhandled rejection'));

const shutdown = () => {
  void app
    .close()
    .then(() => db.end())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
