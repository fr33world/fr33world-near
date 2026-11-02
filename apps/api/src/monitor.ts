/**
 * The invariant monitor (technical-plan §7.5): checks the books (ledger.ts `audit`) every
 * minute while money is moving, and once at start. Every balance must sum to zero (what the
 * players and escrow hold is exactly what faucets paid in less what sinks took out), every
 * stored balance must match its entries, and every transaction must balance. A failed check
 * pauses the economy (migration 010: the database then refuses all but corrections), records
 * an alert, logs it, and posts it to ALERT_WEBHOOK_URL when set (a Discord or Slack webhook).
 * Each check also runs the anomaly scan (anomalies.ts). Nothing posts while the API is idle, so idle minutes are skipped and the database can sleep.
 */
import { scan } from './anomalies.ts';
import type { Db } from './db.ts';
import { type Audit, audit, ledgerActivity } from './ledger.ts';

export interface EconomyState {
  paused: boolean;
  pausedAt: string | null;
  reason: string | null;
}

export async function economyState(db: Db): Promise<EconomyState> {
  const r = await db.query<{ paused_at: string | null; reason: string | null }>(
    'select paused_at, reason from economy_control where id = 1',
  );
  const row = r.rows[0];
  return {
    paused: !!row?.paused_at,
    pausedAt: row?.paused_at ?? null,
    reason: row?.reason ?? null,
  };
}

export async function pauseEconomy(db: Db, reason: string): Promise<void> {
  await db.query(
    `update economy_control set paused_at = coalesce(paused_at, now()), reason = $1 where id = 1`,
    [reason],
  );
}

export async function resumeEconomy(db: Db, by: string): Promise<void> {
  await db.query(
    `update economy_control set paused_at = null, reason = null, resumed_by = $1, resumed_at = now()
     where id = 1`,
    [by],
  );
  await alert(db, 'resumed', { by });
}

export async function alert(
  db: Db,
  kind: string,
  details: Record<string, unknown>,
  webhook = process.env.ALERT_WEBHOOK_URL,
): Promise<void> {
  await db.query('insert into economy_alerts (kind, details) values ($1, $2)', [kind, details]);
  console.error(`economy alert: ${kind}`, details);
  if (webhook)
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: `fr33world economy: ${kind} ${JSON.stringify(details)}` }),
    }).catch((e: unknown) => console.error('alert webhook failed', e));
}

export async function recentAlerts(db: Db, limit = 50) {
  const r = await db.query<{
    id: number;
    kind: string;
    details: Record<string, unknown>;
    created_at: string;
  }>('select * from economy_alerts order by id desc limit $1', [limit]);
  return r.rows;
}

/** What's wrong with these books, if anything. */
export function problems(a: Audit): string[] {
  const out: string[] = [];
  if (a.total !== 0) out.push(`balances sum to ${a.total}, not 0`);
  if (a.drifted > 0) out.push(`${a.drifted} balances differ from their entries`);
  if (a.unbalanced > 0) out.push(`${a.unbalanced} transactions don't balance`);
  return out;
}

/** One check: on any problem, pause and alert. Returns what it found. */
export async function check(db: Db, books: (db: Db) => Promise<Audit> = audit) {
  const a = await books(db);
  const found = problems(a);
  if (found.length > 0) {
    const state = await economyState(db);
    await pauseEconomy(db, found.join('; '));
    if (!state.paused) await alert(db, 'paused', { problems: found, audit: a });
  }
  return { ok: found.length === 0, audit: a, problems: found };
}

/** Checks every `everyMs` while the ledger has posted since the last check. */
export function startMonitor(db: Db, everyMs = 60_000): () => void {
  let checkedAt = -1;
  const run = () => {
    if (ledgerActivity.lastPostAt <= checkedAt) return;
    checkedAt = Date.now();
    check(db)
      .then(() => scan(db))
      .catch((e: unknown) => console.error('economy check failed', e));
  };
  // Once at start, whatever the activity (lastPostAt starts at 0).
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
