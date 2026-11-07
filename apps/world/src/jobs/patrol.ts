/**
 * A patrol (owner's launch-eve list): officers on duty take one from the board in the Station,
 * then drive or walk past four addresses around the city. Each checks itself off on arrival, so
 * there's no getting out at every stop, and the round pays when the last is done. On top of the
 * salary, so a quiet shift still has something to do, and it puts officers out on the streets
 * where 911 calls come from. Going off duty ends it.
 */
import { SPEED } from '@fr33world/shared';
import type { JobDef, JobView } from './jobs.ts';

export interface PatrolState {
  board: number;
  stops: number[];
  done: number;
  startedAt: number;
  lastAt: number;
}

export const PATROL = {
  stops: 4,
  /** How close to a stop counts as there (m): a car passes it on the road outside. */
  radius: 24,
  nearest: 250,
  furthest: 1000,
  /** Stops at least this far apart (m), so a round covers ground. */
  apart: 220,
  roundMs: 15 * 60_000,
  perStop: 4_000,
  xpPerStop: 15,
} as const;

/** No sooner between stops than a car could get there. */
const FASTEST = SPEED.VEHICLE_MAX * 1.25;

export const patrol: JobDef<PatrolState> = {
  id: 'patrol',
  title: 'Patrol',
  offeredAt: 'patrol',
  offer: 'Start a patrol',
  cooldownMs: 120_000,
  keepAlive: 'reach your next stop',

  start(ctx, p, board) {
    if (p.faction !== 'police' || !p.onDuty) return 'Patrols are for police on duty.';
    const door = ctx.points.find((q) => q.kind === 'entrance' && q.service === 'police');
    if (!door) return 'No patrols today.';
    const pool = ctx.points
      .map((q, i) => ({ q, i, far: Math.hypot(q.x - door.x, q.z - door.z) }))
      .filter(({ q, far }) => q.kind === 'door' && far > PATROL.nearest && far < PATROL.furthest);
    const stops: number[] = [];
    while (stops.length < PATROL.stops && pool.length > 0) {
      const pick = pool.splice(Math.floor(ctx.random() * pool.length), 1)[0];
      if (!pick) break;
      const clear = stops.every((i) => {
        const s = ctx.points[i];
        return s && Math.hypot(s.x - pick.q.x, s.z - pick.q.z) > PATROL.apart;
      });
      if (clear) stops.push(pick.i);
    }
    if (stops.length < PATROL.stops) return 'No patrols today.';
    return { board, stops, done: 0, startedAt: ctx.now, lastAt: ctx.now };
  },

  use() {
    return 'Just get to the marker: it checks itself off.';
  },

  near(ctx, s, p) {
    if (!p.onDuty) return { state: null, say: 'Off duty: patrol over.' };
    const to = ctx.points[s.stops[s.done] ?? -1];
    if (!to || Math.hypot(to.x - p.x, to.z - p.z) > PATROL.radius) return null;
    const from =
      s.done === 0
        ? ctx.points.find((q) => q.kind === 'entrance' && q.service === 'police')
        : ctx.points[s.stops[s.done - 1] ?? -1];
    if (from && ctx.now - s.lastAt < (Math.hypot(to.x - from.x, to.z - from.z) / FASTEST) * 1000)
      return null;
    const done = s.done + 1;
    if (done < s.stops.length)
      return {
        state: { ...s, done, lastAt: ctx.now },
        say: `All clear at ${to.name ?? 'that stop'}. On to the next.`,
      };
    return {
      state: null,
      pay: {
        cents: PATROL.perStop * done,
        xp: PATROL.xpPerStop * done,
        reason: 'Patrol',
        key: `patrol:${ctx.shift}`,
      },
      say: 'Patrol done. The city thanks you.',
    };
  },

  view(ctx, s): JobView {
    const t = ctx.points[s.stops[s.done] ?? -1];
    return {
      job: 'patrol',
      title: 'Patrol',
      step: `Go to ${t?.name ?? '?'}`,
      objective: t ? { x: t.x, z: t.z, label: t.name ?? 'Patrol stop' } : null,
      actions: [],
      progress: { done: s.done, total: s.stops.length, label: 'Stops' },
      endsAt: s.startedAt + PATROL.roundMs,
      earned: { cents: 0, xp: 0 },
    };
  },

  expired(ctx, s) {
    return ctx.now > s.startedAt + PATROL.roundMs ? 'Took too long: the patrol is off.' : null;
  },
};
