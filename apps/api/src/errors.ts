/**
 * Client error reports (migrations/003). Grouped by fingerprint: the message plus the first
 * frame of the stack, with numbers (line, column, ids) blurred so one bug is one row.
 */
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';

export interface ErrorReport {
  message: string;
  stack: string;
  url: string;
  build: string;
  userAgent: string;
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');

export function readReport(body: unknown, userAgent: string): ErrorReport | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const message = clip(b.message, 500).trim();
  if (!message) return null;
  return {
    message,
    stack: clip(b.stack, 4000),
    url: clip(b.url, 300),
    build: clip(b.build, 40),
    userAgent: userAgent.slice(0, 300),
  };
}

export function fingerprint(r: Pick<ErrorReport, 'message' | 'stack'>): string {
  const firstFrame = r.stack.split('\n').find((l) => /\bat\b|@/.test(l)) ?? '';
  const blur = (s: string) => s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update(`${blur(r.message)}|${blur(firstFrame)}`)
    .digest('hex')
    .slice(0, 32);
}

export async function recordError(db: Db, r: ErrorReport): Promise<void> {
  await db.query(
    `insert into client_errors (fingerprint, message, sample) values ($1, $2, $3)
     on conflict (fingerprint) do update
       set count = client_errors.count + 1, last_seen = now(), sample = excluded.sample`,
    [
      fingerprint(r),
      r.message,
      { stack: r.stack, url: r.url, build: r.build, userAgent: r.userAgent },
    ],
  );
  // Cheap pruning, about once in a hundred reports.
  if (Math.random() < 0.01) {
    await db.query("delete from client_errors where last_seen < now() - interval '30 days'");
  }
}

export interface ErrorGroup {
  fingerprint: string;
  message: string;
  count: number;
  first_seen: Date;
  last_seen: Date;
  sample: { stack: string; url: string; build: string; userAgent: string };
}

export async function recentErrors(db: Db, limit = 50): Promise<ErrorGroup[]> {
  const r = await db.query<ErrorGroup>(
    `select fingerprint, message, count, first_seen, last_seen, sample
     from client_errors order by last_seen desc limit $1`,
    [limit],
  );
  return r.rows;
}
