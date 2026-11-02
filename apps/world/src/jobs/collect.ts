/**
 * Collections (Phase 9 gang job): gang members start at their hideout, call at three addresses
 * on their turf (on foot, a moment at each door), and bring the takings back to the hideout,
 * paid then. Only for the hideout's own gang.
 */
import { districtAt, type District } from '@fr33world/city';
import { SPEED } from '@fr33world/shared';
import type { JobDef, JobView } from './jobs.ts';

export interface CollectState {
  hideout: number;
  stops: number[];
  done: number;
  startedAt: number;
  lastAt: number;
  earned: { cents: number; xp: number };
}

const TURF: Record<string, District> = { vipers: 'eastside', kings: 'south_grid' };
const STOPS = 3;
const ROUND_MS = 20 * 60_000;
export const COLLECT_PAY = { perStop: 6_000, xpPerStop: 20 } as const;
/** No sooner between doors than a runner could get there. */
const FASTEST = SPEED.RUN * 1.4;

export const collect: JobDef<CollectState> = {
  id: 'collect',
  title: 'Collections',
  offeredAt: 'hideout',
  offer: 'Run collections',
  cooldownMs: 120_000,
  keepAlive: 'make your calls',

  start(ctx, p, hideout) {
    const h = ctx.points[hideout];
    const gang = h?.gang;
    if (!h || !gang) return 'Nobody here.';
    if (p.faction !== gang) return 'Members only.';
    const turf = TURF[gang];
    const doors = ctx.points
      .map((q, i) => ({ q, i }))
      .filter(
        ({ q }) =>
          q.kind === 'door' &&
          districtAt(q.x, q.z) === turf &&
          Math.hypot(q.x - h.x, q.z - h.z) > 60 &&
          Math.hypot(q.x - h.x, q.z - h.z) < 500,
      );
    if (doors.length < STOPS) return 'Nothing to collect today.';
    const stops: number[] = [];
    while (stops.length < STOPS) {
      const pick = doors.splice(Math.floor(ctx.random() * doors.length), 1)[0];
      if (pick) stops.push(pick.i);
    }
    return {
      hideout,
      stops,
      done: 0,
      startedAt: ctx.now,
      lastAt: ctx.now,
      earned: { cents: 0, xp: 0 },
    };
  },

  use(ctx, s, p, i) {
    if (!p.onFoot) return 'Do this on foot.';
    const back = s.done >= s.stops.length;
    const target = back ? s.hideout : s.stops[s.done];
    if (i !== target) return back ? 'Take it back to the hideout.' : 'Not this door.';
    const from = ctx.points[s.done === 0 ? s.hideout : (s.stops[s.done - 1] ?? s.hideout)];
    const to = ctx.points[target];
    if (
      from &&
      to &&
      ctx.now - s.lastAt < (Math.hypot(to.x - from.x, to.z - from.z) / FASTEST) * 1000
    )
      return 'Too quick.';
    if (back) {
      const cents = COLLECT_PAY.perStop * s.stops.length;
      const xp = COLLECT_PAY.xpPerStop * s.stops.length;
      return {
        state: null,
        pay: { cents, xp, reason: 'Collections', key: `collect:${ctx.shift}` },
        say: 'The crew takes its cut. Come back later for more.',
      };
    }
    const done = s.done + 1;
    return {
      state: { ...s, done, lastAt: ctx.now },
      say:
        done >= s.stops.length
          ? 'That’s all of them: back to the hideout.'
          : 'Collected. Next door.',
    };
  },

  view(ctx, s): JobView {
    const back = s.done >= s.stops.length;
    const target = back ? s.hideout : s.stops[s.done];
    const t = target === undefined ? undefined : ctx.points[target];
    return {
      job: 'collect',
      title: 'Collections',
      step: back ? 'Take it back to the hideout' : `Call at ${t?.name ?? '?'}`,
      objective: t ? { x: t.x, z: t.z, label: back ? 'Hideout' : (t.name ?? 'Door') } : null,
      actions:
        target === undefined
          ? []
          : [
              {
                point: target,
                label: back ? 'Hand it over' : 'Collect',
                icon: 'door',
                holdMs: 2500,
              },
            ],
      progress: { done: s.done, total: s.stops.length, label: 'Calls' },
      endsAt: s.startedAt + ROUND_MS,
      earned: s.earned,
    };
  },

  expired(ctx, s) {
    return ctx.now > s.startedAt + ROUND_MS ? 'Took too long: the round is off.' : null;
  },
};
