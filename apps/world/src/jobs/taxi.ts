/**
 * Taxi driver (Phase 6; Taxi Office): take a shift at the office by the plaza (a company cab is
 * brought to you), then drive fares: pick each one up at the curb where they wait, in the car,
 * and let them out at the curb of their address. Each fare pays by the road distance driven
 * (city RoadGraph) and XP, no sooner than a fast car could have driven it. Five fares a shift;
 * a shift left too long ends.
 */
import { SPEED } from '@fr33world/shared';
import type { JobContext, JobDef, JobView } from './jobs.ts';

export interface TaxiState {
  /** The fare now: where they wait and where they're going (point indices). */
  pickup: number;
  dropoff: number;
  aboard: boolean;
  /** Fares done of the shift's FARES. */
  done: number;
  startedAt: number;
  pickedAt: number;
  earned: { cents: number; xp: number };
}

export const TAXI_PAY = {
  base: 2_000,
  perMetre: 6,
  maxFare: 25_000,
  xpBase: 12,
  xpPerKm: 15,
} as const;
const FARES = 5;
const SHIFT_MS = 30 * 60_000;
const FASTEST = SPEED.VEHICLE_MAX * 1.25;

/** A fare from somewhere near `from` (200–900 m) to an address 300–1500 m on. */
function nextFare(
  ctx: JobContext,
  from: { x: number; z: number },
): { pickup: number; dropoff: number } | null {
  const fares = ctx.points.map((q, i) => ({ q, i })).filter(({ q }) => q.kind === 'fare');
  const near = fares.filter(({ q }) => {
    const d = Math.hypot(q.x - from.x, q.z - from.z);
    return d > 200 && d < 900;
  });
  const pick = near[Math.floor(ctx.random() * near.length)];
  if (!pick) return null;
  const far = fares.filter(({ q }) => {
    const d = Math.hypot(q.x - pick.q.x, q.z - pick.q.z);
    return d > 300 && d < 1500;
  });
  const drop = far[Math.floor(ctx.random() * far.length)];
  return drop ? { pickup: pick.i, dropoff: drop.i } : null;
}

export const taxi: JobDef<TaxiState> = {
  id: 'taxi',
  title: 'Taxi driver',
  offeredAt: 'taxi_depot',
  offer: 'Start a taxi shift',
  minLevel: 2,
  cooldownMs: 20_000,
  keepAlive: 'pick up and drop off fares',

  start(ctx, p) {
    const fare = nextFare(ctx, { x: p.x, z: p.z });
    if (!fare) return 'No fares right now.';
    return {
      ...fare,
      aboard: false,
      done: 0,
      startedAt: ctx.now,
      pickedAt: 0,
      earned: { cents: 0, xp: 0 },
    };
  },

  use(ctx, s, p, i) {
    if (p.onFoot) return 'Fares are picked up and let out from the car.';
    if (!s.aboard) {
      if (i !== s.pickup) return 'Your fare is waiting somewhere else.';
      return {
        state: { ...s, aboard: true, pickedAt: ctx.now },
        say: `Fare aboard: to ${ctx.points[s.dropoff]?.name ?? '?'}.`,
      };
    }
    if (i !== s.dropoff) return `They're going to ${ctx.points[s.dropoff]?.name ?? '?'}.`;
    const from = ctx.points[s.pickup];
    const to = ctx.points[s.dropoff];
    if (!from || !to) return { state: null };
    const road =
      ctx.roads.route(from.x, from.z, to.x, to.z)?.length ??
      Math.hypot(to.x - from.x, to.z - from.z);
    if (ctx.now - s.pickedAt < (road / FASTEST) * 1000)
      return 'That was quicker than any car could manage.';
    const cents = Math.min(TAXI_PAY.maxFare, TAXI_PAY.base + Math.round(road * TAXI_PAY.perMetre));
    const xp = Math.round(TAXI_PAY.xpBase + (road / 1000) * TAXI_PAY.xpPerKm);
    const done = s.done + 1;
    const pay = { cents, xp, reason: `Fare · ${to.name}`, key: `taxi:${ctx.shift}:${done}` };
    const earned = { cents: s.earned.cents + cents, xp: s.earned.xp + xp };
    if (done >= FARES)
      return {
        state: null,
        pay,
        say: 'Shift done: five fares. Back to the Taxi Office for another.',
      };
    const fare = nextFare(ctx, to);
    if (!fare) return { state: null, pay, say: 'No more fares about: shift over.' };
    return {
      state: { ...fare, aboard: false, done, startedAt: s.startedAt, pickedAt: 0, earned },
      pay,
      say: `Paid. Next fare waits at ${ctx.points[fare.pickup]?.name ?? '?'}.`,
    };
  },

  view(ctx, s): JobView {
    const target = s.aboard ? s.dropoff : s.pickup;
    const t = ctx.points[target];
    return {
      job: 'taxi',
      title: 'Taxi',
      step: s.aboard ? `Drive them to ${t?.name ?? '?'}` : `Pick up the fare at ${t?.name ?? '?'}`,
      objective: t
        ? { x: t.x, z: t.z, label: s.aboard ? (t.name ?? 'Drop-off') : 'Fare waiting' }
        : null,
      actions: [
        {
          point: target,
          label: s.aboard ? 'Let them out' : 'Pick up fare',
          icon: 'talk',
          holdMs: 800,
        },
      ],
      cargo: s.aboard ? { label: 'Passenger', count: 1 } : undefined,
      progress: { done: s.done, total: FARES, label: 'Fares' },
      endsAt: s.startedAt + SHIFT_MS,
      earned: s.earned,
    };
  },

  expired(ctx, s) {
    return ctx.now > s.startedAt + SHIFT_MS
      ? 'Your shift is over: the cab went back to the Taxi Office.'
      : null;
  },
};
