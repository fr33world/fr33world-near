/**
 * Mining (PRD §7.1): sign on at the quarry's site office, swing at the ore faces in the pit
 * (a timed swing on the client; the server takes at most one strike every STRIKE_MS, and an
 * ore needs several), carry what you dig (a bag of BAG pieces), and sell it at Harbor Metals
 * in the port. Faces run out as everyone mines them and refill slowly, so a face can't be
 * farmed forever. The sale pays by grade (copper, iron, gold) in money and XP; an idle shift
 * ends by itself (ore still in the bag is lost).
 */
import { ORE_GRADES } from '@fr33world/city';
import type { JobContext, JobDef, JobView } from './jobs.ts';

export interface MiningState {
  office: number;
  /** Pieces carried, by grade. */
  bag: [number, number, number];
  /** The face being worked, and strikes into its current piece. */
  face: number;
  strikes: number;
  lastStrikeAt: number;
  lastActiveAt: number;
  sales: number;
  earned: { cents: number; xp: number };
}

export const MINING = {
  bag: 6,
  /** Strikes per piece, by grade, and the least time between strikes (ms). */
  strikes: [4, 5, 7] as const,
  strikeMs: 700,
  /** What each piece sells for (cents) and its XP, by grade. */
  price: [3_000, 5_500, 14_000] as const,
  xp: [8, 12, 25] as const,
  /** Pieces a face holds, and how fast it refills (ms a piece). */
  faceHolds: 10,
  refillMs: 30_000,
  idleMs: 15 * 60_000,
} as const;

/** How much ore a face has now (shared by every miner), refilled with time. */
function faceLeft(ctx: JobContext, face: number): { left: number; at: number } {
  const key = `face:${face}`;
  const was = (ctx.shared.get(key) as { left: number; at: number } | undefined) ?? {
    left: MINING.faceHolds,
    at: ctx.now,
  };
  const refill = Math.floor((ctx.now - was.at) / MINING.refillMs);
  const left = Math.min(MINING.faceHolds, was.left + refill);
  const now = { left, at: refill > 0 ? was.at + refill * MINING.refillMs : was.at };
  ctx.shared.set(key, now);
  return now;
}

const carried = (s: MiningState) => s.bag[0] + s.bag[1] + s.bag[2];

export const mining: JobDef<MiningState> = {
  id: 'mining',
  title: 'Mining',
  offeredAt: 'quarry_office',
  offer: 'Sign on for mining',
  keepAlive: 'mine or sell ore',
  cooldownMs: 10_000,

  start(ctx, _p, office) {
    return {
      office,
      bag: [0, 0, 0],
      face: -1,
      strikes: 0,
      lastStrikeAt: 0,
      lastActiveAt: ctx.now,
      sales: 0,
      earned: { cents: 0, xp: 0 },
    };
  },

  use(ctx, s, p, i) {
    const q = ctx.points[i];
    if (!q) return 'Nothing here.';
    if (q.kind === 'ore') {
      if (!p.onFoot) return 'Get out to mine.';
      if (carried(s) >= MINING.bag)
        return 'Your bag is full: sell it at Harbor Metals in the port.';
      // Too soon after the last strike: ignored (the swing is still going).
      if (ctx.now - s.lastStrikeAt < MINING.strikeMs) return { state: s };
      const grade = q.grade ?? 0;
      const face = faceLeft(ctx, i);
      if (face.left <= 0) return 'This face is worked out for now. Try another.';
      const strikes = (s.face === i ? s.strikes : 0) + 1;
      const needed = MINING.strikes[grade] ?? 4;
      const base = { ...s, face: i, lastStrikeAt: ctx.now, lastActiveAt: ctx.now };
      if (strikes < needed) return { state: { ...base, strikes } };
      ctx.shared.set(`face:${i}`, { left: face.left - 1, at: face.at });
      const bag = [...s.bag] as MiningState['bag'];
      bag[grade as 0 | 1 | 2] += 1;
      return {
        state: { ...base, strikes: 0, bag },
        say: `+1 ${ORE_GRADES[grade]?.toLowerCase()} ore (${carried(s) + 1}/${MINING.bag}).`,
      };
    }
    if (q.kind === 'buyer') {
      const n = carried(s);
      if (n === 0) return 'Nothing to sell: mine some ore first.';
      const cents = s.bag.reduce((sum, k, g) => sum + k * (MINING.price[g] ?? 0), 0);
      const xp = s.bag.reduce((sum, k, g) => sum + k * (MINING.xp[g] ?? 0), 0);
      const what = s.bag
        .map((k, g) => (k ? `${k} ${ORE_GRADES[g]?.toLowerCase()}` : ''))
        .filter(Boolean)
        .join(', ');
      const sales = s.sales + 1;
      return {
        state: {
          ...s,
          bag: [0, 0, 0],
          sales,
          lastActiveAt: ctx.now,
          earned: { cents: s.earned.cents + cents, xp: s.earned.xp + xp },
        },
        pay: { cents, xp, reason: `Ore sold · ${what}`, key: `mining:${ctx.shift}:${sales}` },
        say: `Sold ${what}.`,
      };
    }
    if (q.kind === 'quarry_office') return 'You’re signed on. Mine at the ore faces in the pit.';
    return 'Nothing to do here.';
  },

  view(ctx, s): JobView {
    const full = carried(s) >= MINING.bag;
    const faces = ctx.points.map((q, i) => ({ q, i })).filter(({ q }) => q.kind === 'ore');
    const buyer = ctx.points.findIndex((q) => q.kind === 'buyer');
    const b = ctx.points[buyer];
    const working = ctx.points[s.face];
    const nearestFace = working ?? faces[0]?.q;
    return {
      job: 'mining',
      title: 'Mining · Los Soles Quarry',
      step: full
        ? 'Bag full: sell at Harbor Metals'
        : carried(s) > 0
          ? 'Mine more, or sell at Harbor Metals'
          : 'Mine ore at the faces in the pit',
      objective: full
        ? b
          ? { x: b.x, z: b.z, label: 'Harbor Metals' }
          : null
        : nearestFace
          ? { x: nearestFace.x, z: nearestFace.z, label: nearestFace.name ?? 'Ore face' }
          : null,
      actions: [
        ...faces.map(({ q, i }) => ({
          point: i,
          label: `Mine ${(q.name ?? 'ore').replace(' face', '').toLowerCase()}`,
          icon: 'job' as const,
          timing: true,
        })),
        ...(buyer >= 0 && carried(s) > 0
          ? [{ point: buyer, label: 'Sell ore', icon: 'talk' as const, holdMs: 900 }]
          : []),
      ],
      cargo: { label: 'Ore', count: carried(s), max: MINING.bag },
      progress:
        s.face >= 0 && s.strikes > 0
          ? {
              done: s.strikes,
              total: MINING.strikes[ctx.points[s.face]?.grade ?? 0] ?? 4,
              label: 'Strikes',
            }
          : undefined,
      endsAt: s.lastActiveAt + MINING.idleMs,
      earned: s.earned,
    };
  },

  expired(ctx, s) {
    return ctx.now > s.lastActiveAt + MINING.idleMs
      ? 'Mining shift over: you were away too long.'
      : null;
  },
};
