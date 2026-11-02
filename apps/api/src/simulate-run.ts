/**
 * Runs the economy simulator (simulate.ts) against a fresh schema in the test database and
 * prints its report. PLAYERS, ROUNDS, BURST, SEED tune it.
 */
import { simulate } from './simulate.ts';
import { testDb } from './test-db.ts';

const env = process.env;
const db = await testDb('simulator');
const started = performance.now();
const report = await simulate(db, {
  players: Number(env.PLAYERS ?? 200),
  rounds: Number(env.ROUNDS ?? 200),
  burst: Number(env.BURST ?? 24),
  seed: Number(env.SEED ?? Date.now() % 100_000),
});
await db.end();
const usd = (c: number) => `$${(c / 100).toLocaleString('en-US')}`;
console.log(
  JSON.stringify(
    {
      ...report,
      issued: usd(report.issued),
      burned: usd(report.burned),
      supply: usd(report.supply),
      balances: Object.fromEntries(Object.entries(report.balances).map(([k, v]) => [k, usd(v)])),
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
    null,
    2,
  ),
);
process.exit(report.problems.length ? 1 : 0);
