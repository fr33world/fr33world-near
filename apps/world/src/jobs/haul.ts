/**
 * A USDC delivery (Phase 17): having taken a job at the Market, load the order at Harbor
 * Wholesale's dock and bring it to the Market's loading bay. The server checks both ends and the
 * time, as for a courier: no teleporting. The pay isn't `$`: it's USDC already held for this job
 * in the business's wallet on chain, released to the player's own account when it's done.
 */
import { SPEED } from '@fr33world/shared';
import type { JobDef } from './jobs.ts';

export interface HaulState {
  dock: number;
  bay: number;
  startedAt: number;
}

const LIMIT_MS = 30 * 60_000;
const FASTEST = SPEED.VEHICLE_MAX * 1.25;

export const haul: JobDef<HaulState> = {
  id: 'haul',
  title: 'USDC delivery',
  offeredAt: 'dock',
  offer: 'Load the Market order',
  cooldownMs: 5_000,

  start(ctx, _p, dock) {
    const bay = ctx.points.findIndex((q) => q.kind === 'bay');
    if (bay < 0) return 'Nothing to load right now.';
    return { dock, bay, startedAt: ctx.now };
  },

  use(ctx, s, _p, i) {
    if (i !== s.bay) return 'Take it to the Market’s loading bay.';
    const from = ctx.points[s.dock];
    const to = ctx.points[s.bay];
    if (!from || !to) return { state: null };
    const road =
      ctx.roads.route(from.x, from.z, to.x, to.z)?.length ??
      Math.hypot(to.x - from.x, to.z - from.z);
    if (ctx.now - s.startedAt < (road / FASTEST) * 1000)
      return 'That was quicker than any car could get here.';
    return { state: null, settle: true, say: 'Delivered. Your USDC is on its way.' };
  },

  view(ctx, s) {
    const bay = ctx.points[s.bay];
    return {
      job: 'haul',
      title: 'USDC delivery',
      step: 'Bring the order to the Market',
      objective: bay ? { x: bay.x, z: bay.z, label: bay.name ?? 'Loading bay' } : null,
      actions: [{ point: s.bay, label: 'Unload the order', icon: 'job' }],
      endsAt: s.startedAt + LIMIT_MS,
      earned: { cents: 0, xp: 0 },
    };
  },

  expired(ctx, s) {
    return ctx.now - s.startedAt > LIMIT_MS ? 'The delivery took too long.' : null;
  },
};
