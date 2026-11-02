/**
 * The headless economy simulator (technical-plan §7.9, Phase 5's gate): many players doing
 * random things at once against the real database rules: job and salary payouts (often past
 * the caps), purchases and fees (often more than they have), payments to each other (some
 * with junk amounts), replays of earlier requests, and admin corrections. It keeps its own
 * model of every wallet from the actions that went through, then checks:
 *   - the books close (every balance sums to zero, none drifted, every transaction balanced);
 *   - no wallet is below zero;
 *   - money in players' hands is exactly what faucets issued less what sinks took;
 *   - every wallet matches the model to the cent (nothing created or duplicated);
 *   - nobody took more from a faucet than its caps allow.
 * Its report (supply, spread of balances, what was refused) is also how faucets and sinks get
 * tuned: `pnpm --filter @fr33world/api simulate` runs a bigger one.
 */
import { FAUCETS, type FaucetName, PAYMENTS } from '@fr33world/shared';
import { pay } from './bank.ts';
import { type Db, inTx } from './db.ts';
import { earn, spend } from './economy.ts';
import { audit, balanceOf, post, systemAccount, walletOf } from './ledger.ts';
import { problems } from './monitor.ts';

export interface SimOptions {
  players: number;
  rounds: number;
  /** Actions at once in each round. */
  burst: number;
  seed: number;
}

interface Sim {
  privy: string;
  id: string;
  name: string;
  wallet: number;
}

type Action = 'job' | 'salary' | 'buy' | 'fee' | 'pay' | 'junk' | 'replay' | 'correction';
const WEIGHTS: [Action, number][] = [
  ['job', 30],
  ['salary', 10],
  ['buy', 14],
  ['fee', 8],
  ['pay', 22],
  ['junk', 4],
  ['replay', 10],
  ['correction', 2],
];

/** A small seeded random source (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
    action: (): Action => {
      let r = next() * WEIGHTS.reduce((s, [, w]) => s + w, 0);
      for (const [a, w] of WEIGHTS) if ((r -= w) < 0) return a;
      return 'job';
    },
  };
}

export interface SimReport {
  actions: Record<Action, { done: number; refused: number }>;
  /** Cents: issued by faucets, taken by sinks, and in players' hands. */
  issued: number;
  burned: number;
  supply: number;
  balances: { min: number; median: number; max: number };
  /** Everything wrong; empty when the economy held. */
  problems: string[];
}

export async function simulate(db: Db, o: SimOptions): Promise<SimReport> {
  const rng = random(o.seed);
  const run = `${o.seed}-${Date.now().toString(36)}`;
  const players: Sim[] = [];
  const model = new Map<string, number>();
  for (let i = 0; i < o.players; i += 1) {
    const privy = `did:privy:sim-${run}-${i}`;
    const r = await db.query<{ id: string }>(
      'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
      [privy, `Sim ${i}`],
    );
    const id = (r.rows[0] as { id: string }).id;
    const name = `Sim ${run.slice(-6)}x${i}`;
    await db.query(
      `insert into characters (account_id, name, age, appearance, created_at)
       values ($1, $2, 30, 0, now() - interval '3 days')`,
      [id, name],
    );
    const wallet = await walletOf(db, id);
    await inTx(db, async (tx) =>
      post(tx, {
        kind: 'signup_bonus',
        key: `signup:${id}`,
        legs: [
          { account: await systemAccount(tx, 'faucet:signup'), amount: -500_000 },
          { account: wallet, amount: 500_000 },
        ],
      }),
    );
    model.set(id, 500_000);
    players.push({ privy, id, name, wallet });
  }

  const actions = Object.fromEntries(
    WEIGHTS.map(([a]) => [a, { done: 0, refused: 0 }]),
  ) as SimReport['actions'];
  /**
   * Earlier requests, to replay. Each carries its effect on the model, applied only when it
   * really posts: a request refused at first (a limit, an overdraft) may go through later.
   */
  const history: (() => Promise<unknown>)[] = [];
  const keep = <T>(req: () => Promise<T>, effect: (r: T) => void) => {
    const run = () =>
      req().then((r) => {
        effect(r);
        return r;
      });
    history.push(run);
    return run();
  };
  let seq = 0;
  const add = (id: string, cents: number) => model.set(id, (model.get(id) ?? 0) + cents);

  const one = (): Promise<unknown> => {
    const action = rng.action();
    const p = rng.pick(players);
    const key = `${run}-${(seq += 1)}`;
    const count = (work: Promise<unknown>) =>
      work.then(
        () => {
          actions[action].done += 1;
        },
        () => {
          actions[action].refused += 1;
        },
      );
    switch (action) {
      case 'job':
      case 'salary': {
        const faucet: FaucetName = action === 'job' ? 'jobs' : 'salary';
        const cents = rng.int(100, FAUCETS[faucet].maxPayment);
        const req = () =>
          inTx(db, (tx) => earn(tx, { accountId: p.id, faucet, cents, key: `${faucet}:${key}` }));
        return count(keep(req, (r) => r.status === 'posted' && add(p.id, r.paid)));
      }
      case 'buy':
      case 'fee': {
        const cents = rng.int(100, Math.max(200, (model.get(p.id) ?? 0) * 1.5));
        const req = () =>
          inTx(db, (tx) =>
            spend(tx, {
              accountId: p.id,
              sink: action === 'buy' ? 'purchases' : 'fees',
              cents,
              key: `spend:${key}`,
              kind: action,
            }),
          );
        return count(keep(req, (r) => r.status === 'posted' && add(p.id, -cents)));
      }
      case 'pay': {
        const to = rng.pick(players.filter((q) => q !== p));
        const cents = rng.int(
          PAYMENTS.min,
          Math.min(PAYMENTS.max, (model.get(p.id) ?? 0) + 50_000),
        );
        const req = () => pay(db, p.privy, { to: to.name, cents, key: `k${key}` });
        return count(
          keep(req, (r) => {
            if (r.status !== 'posted') return;
            add(p.id, -cents);
            add(to.id, cents);
          }),
        );
      }
      case 'junk': {
        const to = rng.pick(players.filter((q) => q !== p));
        const cents = rng.pick([-500, 0, 0.5, Number.NaN, 2 ** 62, Number.MAX_SAFE_INTEGER, '100']);
        return count(pay(db, p.privy, { to: to.name, cents, key: `k${key}` }));
      }
      case 'replay': {
        const again = history.length ? rng.pick(history) : null;
        // A replay of something that posted posts nothing new; of something refused, it may.
        return count(again ? again() : Promise.reject(new Error('nothing yet')));
      }
      case 'correction': {
        const cents = rng.next() < 0.7 ? rng.int(100, 20_000) : -rng.int(100, 5_000);
        const req = () =>
          inTx(db, async (tx) =>
            post(tx, {
              kind: 'correction',
              key: `correction:${key}`,
              actor: 'staff:simulator',
              legs: [
                { account: p.wallet, amount: cents },
                {
                  account: await systemAccount(
                    tx,
                    cents > 0 ? 'faucet:corrections' : 'sink:corrections',
                  ),
                  amount: -cents,
                },
              ],
            }),
          );
        return count(keep(req, (r) => r.status === 'posted' && add(p.id, cents)));
      }
    }
  };

  for (let round = 0; round < o.rounds; round += 1)
    await Promise.allSettled(Array.from({ length: o.burst }, one));

  // The checks.
  const found: string[] = [];
  const books = await audit(db);
  found.push(...problems(books));
  const totals = await db.query<{ issued: number; burned: number; supply: number }>(
    `select coalesce(-sum(balance) filter (where kind = 'faucet'), 0)::bigint as issued,
            coalesce(sum(balance) filter (where kind = 'sink'), 0)::bigint as burned,
            coalesce(sum(balance) filter (where kind in ('player', 'escrow')), 0)::bigint as supply
     from ledger_accounts`,
  );
  const t = totals.rows[0] as { issued: number; burned: number; supply: number };
  if (t.supply !== t.issued - t.burned)
    found.push(`supply ${t.supply} is not issued ${t.issued} less burned ${t.burned}`);
  const balances: number[] = [];
  for (const p of players) {
    const real = await balanceOf(db, p.wallet);
    balances.push(real);
    if (real < 0) found.push(`${p.name} is below zero (${real})`);
    if (real !== model.get(p.id))
      found.push(`${p.name} holds ${real}, should hold ${model.get(p.id)}`);
  }
  for (const [name, f] of Object.entries(FAUCETS)) {
    if (name === 'signup') continue;
    const over = await db.query<{ owner_id: string; cents: number }>(
      `select la.owner_id, sum(w.amount)::bigint as cents
       from ledger_entries w
       join ledger_accounts la on la.id = w.account_id and la.kind = 'player'
       join ledger_entries f on f.tx_id = w.tx_id
       join ledger_accounts fa on fa.id = f.account_id and fa.code = $1
       where w.amount > 0 and la.owner_id = any($3::uuid[])
       group by la.owner_id having sum(w.amount) > $2`,
      [f.account, Math.min(f.perHour, f.perDay), players.map((p) => p.id)],
    );
    for (const r of over.rows)
      found.push(`${r.owner_id} took ${r.cents} from ${name}, past its cap`);
  }
  if (actions.junk.done > 0) found.push(`${actions.junk.done} junk payments went through`);

  balances.sort((a, b) => a - b);
  return {
    actions,
    issued: t.issued,
    burned: t.burned,
    supply: t.supply,
    balances: {
      min: balances[0] ?? 0,
      median: balances[Math.floor(balances.length / 2)] ?? 0,
      max: balances.at(-1) ?? 0,
    },
    problems: found,
  };
}
