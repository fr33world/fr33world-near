/**
 * Courier (PRD §7.2): take a shift at Courier Depot's lockers on the plaza, collect the packages
 * for a route of 3–5 addresses, and deliver each at the building's door, on foot. Each delivery
 * pays by the road distance from the last stop (city RoadGraph) and XP; the whole route pays a
 * bonus. The server checks every delivery: the right door, in reach, on foot, the packages
 * collected, and not sooner than a car could have driven there (no teleporting). A route left
 * too long goes back to the depot; deliveries already made stay paid.
 */
import { SPEED } from '@fr33world/shared';
import type { JobContext, JobDef, JobView } from './jobs.ts';

export interface CourierState {
  depot: number;
  /** Door point indices, in order. */
  stops: number[];
  /** Deliveries made (the next stop is stops[done]). */
  done: number;
  loaded: boolean;
  startedAt: number;
  /** When the last stop (or the pickup) was made, and where. */
  lastAt: number;
  lastPoint: number;
  earned: { cents: number; xp: number };
}

/** Pay: a base per delivery plus per metre of road from the last stop; a bonus for the route. */
export const COURIER_PAY = {
  base: 2_500,
  perMetre: 8,
  maxLeg: 30_000,
  bonus: 4_000,
  xpBase: 15,
  xpPerKm: 20,
  xpBonus: 30,
} as const;
const ROUTE_MS = 25 * 60_000;
/** Deliveries no sooner than the road distance at a fast car's speed (with a little slack). */
const FASTEST = SPEED.VEHICLE_MAX * 1.25;

const point = (ctx: JobContext, i: number) => ctx.points[i];

export const courier: JobDef<CourierState> = {
  id: 'courier',
  title: 'Courier',
  offeredAt: 'depot',
  offer: 'Start a courier shift',
  cooldownMs: 20_000,

  start(ctx, _p, depot) {
    const d = point(ctx, depot);
    if (!d) return 'No depot here.';
    // Doors 150–900 m from the depot, then 3–5 of them, each next the nearest from the last.
    const near = ctx.points
      .map((q, i) => ({ q, i }))
      .filter(
        ({ q }) =>
          q.kind === 'door' &&
          Math.hypot(q.x - d.x, q.z - d.z) > 150 &&
          Math.hypot(q.x - d.x, q.z - d.z) < 900,
      );
    if (near.length < 5) return 'No deliveries right now.';
    const count = 3 + Math.floor(ctx.random() * 3);
    const pool = [...near];
    const picked: typeof near = [];
    while (picked.length < count && pool.length > 0) {
      const k = Math.floor(ctx.random() * pool.length);
      picked.push(...pool.splice(k, 1));
    }
    const stops: number[] = [];
    let at = { x: d.x, z: d.z };
    while (picked.length > 0) {
      let best = 0;
      picked.forEach(({ q }, k) => {
        const b = picked[best]?.q;
        if (b && Math.hypot(q.x - at.x, q.z - at.z) < Math.hypot(b.x - at.x, b.z - at.z)) best = k;
      });
      const [next] = picked.splice(best, 1);
      if (!next) break;
      stops.push(next.i);
      at = next.q;
    }
    return {
      depot,
      stops,
      done: 0,
      loaded: false,
      startedAt: ctx.now,
      lastAt: ctx.now,
      lastPoint: depot,
      earned: { cents: 0, xp: 0 },
    };
  },

  use(ctx, s, p, i) {
    if (!s.loaded) {
      if (i !== s.depot) return 'Collect the packages from the lockers first.';
      return {
        state: { ...s, loaded: true, lastAt: ctx.now, lastPoint: s.depot },
        say: `${s.stops.length} packages loaded. First stop: ${point(ctx, s.stops[0] ?? -1)?.name ?? '?'}.`,
      };
    }
    const target = s.stops[s.done];
    if (target === undefined) return { state: null };
    if (i !== target) {
      const q = point(ctx, i);
      return q?.kind === 'door'
        ? `Wrong address: this package is for ${point(ctx, target)?.name}.`
        : 'Nothing to do here.';
    }
    if (!p.onFoot) return 'Get out and walk it to the door.';
    const from = point(ctx, s.lastPoint);
    const to = point(ctx, target);
    if (!from || !to) return { state: null };
    const road =
      ctx.roads.route(from.x, from.z, to.x, to.z)?.length ??
      Math.hypot(to.x - from.x, to.z - from.z);
    if (ctx.now - s.lastAt < (road / FASTEST) * 1000)
      return 'That was quicker than any car could get here.';
    const done = s.done + 1;
    const last = done === s.stops.length;
    const cents =
      Math.min(COURIER_PAY.maxLeg, COURIER_PAY.base + Math.round(road * COURIER_PAY.perMetre)) +
      (last ? COURIER_PAY.bonus : 0);
    const xp =
      Math.round(COURIER_PAY.xpBase + (road / 1000) * COURIER_PAY.xpPerKm) +
      (last ? COURIER_PAY.xpBonus : 0);
    const earned = { cents: s.earned.cents + cents, xp: s.earned.xp + xp };
    const pay = {
      cents,
      xp,
      reason: last ? `Route complete · ${to.name}` : `Delivery · ${to.name}`,
      key: `courier:${ctx.shift}:${done}`,
    };
    if (last)
      return { state: null, pay, say: 'Route complete. Head back to the depot for another.' };
    return {
      state: { ...s, done, lastAt: ctx.now, lastPoint: target, earned },
      pay,
      say: `Delivered. Next: ${point(ctx, s.stops[done] ?? -1)?.name}.`,
    };
  },

  view(ctx, s): JobView {
    const target = s.loaded ? s.stops[s.done] : s.depot;
    const t = target === undefined ? undefined : point(ctx, target);
    return {
      job: 'courier',
      title: 'Courier',
      step: s.loaded ? `Deliver to ${t?.name ?? '?'}` : 'Collect the packages at the lockers',
      objective: t
        ? { x: t.x, z: t.z, label: s.loaded ? (t.name ?? 'Delivery') : 'Courier Depot lockers' }
        : null,
      actions:
        target === undefined
          ? []
          : [
              s.loaded
                ? { point: target, label: 'Deliver package', icon: 'door', holdMs: 900 }
                : { point: target, label: 'Collect packages', icon: 'job', holdMs: 1200 },
            ],
      cargo: s.loaded ? { label: 'Packages', count: s.stops.length - s.done } : undefined,
      progress: { done: s.done, total: s.stops.length, label: 'Deliveries' },
      endsAt: s.startedAt + ROUTE_MS,
      earned: s.earned,
    };
  },

  expired(ctx, s) {
    return ctx.now > s.startedAt + ROUTE_MS
      ? 'Out of time: the rest of the packages went back to the depot.'
      : null;
  },
};
