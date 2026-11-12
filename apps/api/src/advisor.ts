/**
 * The AI advisor (Phase 17; D-43): how a business adjusts its markup and stock target. It sees
 * only numbers from this database, never anything a player wrote, so nobody can talk a business
 * into anything. Its answer is a suggestion: shared `clampProposal` cuts it to the limits, it
 * touches no key and no money, and the wallet contract still has the last word on any spending.
 * With no model, or a bad answer, the business carries on by its rules.
 *
 * NEAR AI Cloud is OpenAI-compatible and runs models in attested enclaves.
 *   NEAR_AI_KEY     API key from cloud.near.ai (unset: no advisor)
 *   NEAR_AI_MODEL   model id
 */
import { type Business, BUSINESSES, clampProposal } from '@fr33world/shared';
import type { Db } from './db.ts';

const URL_CHAT = 'https://cloud-api.near.ai/v1/chat/completions';
/** Runs in an attested enclave on NEAR AI Cloud, and is cheap enough to ask daily. */
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const REASON_CHARS = 200;

export type Ask = (system: string, user: string) => Promise<string>;

export function nearAi(key: string, model: string): Ask {
  return async (system, user) => {
    const r = await fetch(URL_CHAT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        // No chain of thought: with it this model took 30 to 80 s per answer (measured
        // 2026-11-12), without it 2 to 7 s, and the answers were as sound. `reasoning_effort`
        // alone still thought for up to 80 s, and overrides this when both are sent.
        chat_template_kwargs: { thinking: false },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`NEAR AI answered ${r.status}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  };
}

const SYSTEM = `You advise one business in a game economy. Reply with one JSON object only:
{"markup": number, "target": integer, "reason": "one short sentence"}.
markup is the share added to cost; target is the stock of each good to hold.
Raise the target if it keeps selling out, lower it if stock sits unsold. Raise the markup a
little when demand is strong and lower it when sales are weak. Small changes only.`;

export interface Numbers {
  markup: number;
  target: number;
  stock: number;
  soldUsdc: number;
  soldDollars: number;
  freeUsdcMicro: number;
}

/** What the model is told: these numbers and nothing else. */
export function brief(b: Business, n: Numbers): string {
  return JSON.stringify({ business: b.id, ...n });
}

/** The first JSON object in an answer, or null. */
function parse(text: string): Record<string, unknown> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Letters, digits and plain punctuation only: a reason is shown to players. */
function plain(v: unknown): string {
  return typeof v === 'string'
    ? v
        .replace(/[^\w\s.,'%()-]/g, '')
        .slice(0, REASON_CHARS)
        .trim()
    : '';
}

async function numbersOf(db: Db, b: Business, freeUsdcMicro: number): Promise<Numbers> {
  const r = await db.query<{ markup: string; target: number; stock: number }>(
    `select b.markup, b.target, coalesce(sum(s.qty), 0)::int as stock from businesses b
     left join business_stock s on s.business = b.id where b.id = $1 group by b.id`,
    [b.id],
  );
  const sold = await db.query<{ usdc: number; usd: number }>(
    `select coalesce(sum(qty) filter (where currency = 'usdc'), 0)::int as usdc,
            coalesce(sum(qty) filter (where currency = 'usd'), 0)::int as usd
     from business_sales
     where business = $1 and status = 'confirmed' and created_at > now() - interval '1 day'`,
    [b.id],
  );
  const row = r.rows[0];
  return {
    markup: Number(row?.markup ?? b.markup),
    target: row?.target ?? b.target,
    stock: row?.stock ?? 0,
    soldUsdc: sold.rows[0]?.usdc ?? 0,
    soldDollars: sold.rows[0]?.usd ?? 0,
    freeUsdcMicro,
  };
}

/** Asks about each business once. Returns how many changed. Never throws: it's only advice. */
export async function advise(
  db: Db,
  ask: Ask,
  freeOf: (b: Business) => Promise<number>,
): Promise<number> {
  let changed = 0;
  for (const b of BUSINESSES) {
    try {
      const n = await numbersOf(db, b, await freeOf(b));
      const answer = parse(await ask(SYSTEM, brief(b, n)));
      if (!answer) continue;
      const next = clampProposal({ ...b, markup: n.markup, target: n.target }, answer);
      const same = next.markup === n.markup && next.target === n.target;
      await db.query(
        `insert into business_decisions (business, source, summary, details)
         values ($1, 'ai', $2, $3)`,
        [
          b.id,
          plain(answer.reason) || 'No change needed',
          { asked: { markup: answer.markup, target: answer.target }, applied: next, numbers: n },
        ],
      );
      if (same) continue;
      await db.query('update businesses set markup = $2, target = $3 where id = $1', [
        b.id,
        next.markup,
        next.target,
      ]);
      changed += 1;
    } catch (e) {
      console.error(`advisor: ${b.id}`, e);
    }
  }
  return changed;
}
