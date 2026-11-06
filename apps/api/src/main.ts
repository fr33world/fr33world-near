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
 *   NEAR_OPERATOR_KEY, NEAR_NETWORK, NEAR_USDC   optional: the economy on NEAR (business.ts,
 *                        usdc.ts); unset = USDC routes say it's off
 *   NEAR_AI_KEY, NEAR_AI_MODEL   optional: the AI advisor (advisor.ts)
 * Applies pending migrations on start, then runs the economy's invariant monitor.
 */
import { assertSecret, privyGuestCheck, privyNearWallet, privyVerifier } from '@fr33world/auth';
import { economyFromEnv, prepareSpend, submitSigned } from '@fr33world/chain';
import { DEFAULT_MODEL, nearAi } from './advisor.ts';
import { buildApp } from './app.ts';
import { createDb } from './db.ts';
import { migrate } from './migrate.ts';
import { alert, startMonitor } from './monitor.ts';

const { PRIVY_APP_ID, PRIVY_APP_SECRET, WORLD_TICKET_SECRET, NEAR_AI_KEY, NEAR_AI_MODEL } =
  process.env;

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
    economy: {
      db,
      chain,
      alert: (text: string) => void alert(db, 'economy', { text }),
      ask: NEAR_AI_KEY ? nearAi(NEAR_AI_KEY, NEAR_AI_MODEL ?? DEFAULT_MODEL) : undefined,
    },
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

process.on('unhandledRejection', (e) => app.log.error(e, 'unhandled rejection'));

const shutdown = () => {
  void app
    .close()
    .then(() => db.end())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
