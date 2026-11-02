/**
 * Taxis (owner, 2026-10-30: transport for new players before they've a car of their own). From
 * the phone, a cab takes a player to where they pick and lets them out on the nearest
 * sidewalk. Free while they're new (below level 5, about the first hour or two of play), then
 * a fare by distance into the purchases sink (economy.ts). Never during a job shift (a cab
 * would make deliveries trivial), and not straight after being shot at.
 */
import { levelOf } from './progression.ts';

export const TAXI = {
  /**
   * Off for launch (owner, 2026-10-31: it felt like teleporting): newcomers rent a car instead
   * (shared RENTAL). Back after launch, with real cabs (track.md).
   */
  enabled: false,
  /** Rides are free below this level. */
  freeBelowLevel: 5,
  /** The fare: a flag fall and a rate per kilometre, in cents. */
  base: 300,
  perKm: 1_500,
  /** Roads wind: the distance charged is the straight line times this. */
  roadFactor: 1.3,
  /** Shortest ride (m): closer than this, walk. */
  minDistance: 60,
  /** Between two rides, and after being hit (ms). */
  cooldownMs: 45_000,
  afterHitMs: 30_000,
} as const;

/** How far a ride from (x0, z0) to (x1, z1) counts as (m). */
export function rideDistance(x0: number, z0: number, x1: number, z1: number): number {
  return Math.hypot(x1 - x0, z1 - z0) * TAXI.roadFactor;
}

/** A ride's fare in cents for a character with `xp` (0 while they're new). */
export function taxiFare(distance: number, xp: number): number {
  if (levelOf(xp).level < TAXI.freeBelowLevel) return 0;
  return TAXI.base + Math.round((distance / 1000) * TAXI.perKm);
}

/** How long the ride takes on screen (s): a few seconds, longer for longer rides. */
export function rideSeconds(distance: number): number {
  return Math.min(6, Math.max(2.5, distance / 400));
}
