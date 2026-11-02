/**
 * Where a taxi lets its passenger out (the phone's Taxi app): the nearest clear stretch of
 * sidewalk to where they asked for, or (in the hills, where roads have no sidewalks) the
 * nearest clear ground. Searched in rings outwards, 2 m apart; the server uses it, so a
 * passenger never lands in a wall, on a carriageway or in the water.
 */
import type { CollisionIndex } from './collision.ts';
import { type CityLayout, carriageHalfWidth, type Road, roadHalfWidth } from './layout.ts';
import { isWalkable } from './plan.ts';

/** How far to look for a sidewalk, and for any clear ground (m). */
const SIDEWALK_REACH = 80;
const GROUND_REACH = 30;
const STEP = 2;

/** On a sidewalk of `r` (clear of the curb and the property line)? */
function onSidewalk(r: Road, x: number, z: number): boolean {
  const along = r.axis === 'ns' ? z : x;
  if (along < r.from || along > r.to) return false;
  const off = Math.abs((r.axis === 'ns' ? x : z) - r.center);
  return off > carriageHalfWidth(r) + 0.6 && off < roadHalfWidth(r) - 0.4;
}

/** On a carriageway (where cars drive)? */
function onCarriageway(r: Road, x: number, z: number): boolean {
  const along = r.axis === 'ns' ? z : x;
  if (along < r.from - 1 || along > r.to + 1) return false;
  return Math.abs((r.axis === 'ns' ? x : z) - r.center) < carriageHalfWidth(r) + 0.3;
}

/** The drop-off nearest (x, z), or null when there's nowhere to stand near it. */
export function dropOff(
  city: CityLayout,
  collision: CollisionIndex,
  x: number,
  z: number,
): { x: number; z: number } | null {
  const clear = (px: number, pz: number) =>
    isWalkable(px, pz) && !collision.pointBlocked(px, pz, 0.6);
  let ground: { x: number; z: number } | null = null;
  for (let ring = 0; ring * STEP <= SIDEWALK_REACH; ring += 1) {
    const rad = ring * STEP;
    const n = ring === 0 ? 1 : Math.ceil((2 * Math.PI * rad) / STEP);
    for (let k = 0; k < n; k += 1) {
      const a = (k / n) * Math.PI * 2;
      const px = x + Math.cos(a) * rad;
      const pz = z + Math.sin(a) * rad;
      const near = city.roads.filter(
        (r) => Math.abs((r.axis === 'ns' ? px : pz) - r.center) < roadHalfWidth(r) + 1,
      );
      if (near.some((r) => onSidewalk(r, px, pz)) && !near.some((r) => onCarriageway(r, px, pz))) {
        if (clear(px, pz)) return { x: px, z: pz };
      } else if (!ground && rad <= GROUND_REACH && !near.some((r) => onCarriageway(r, px, pz))) {
        if (clear(px, pz)) ground = { x: px, z: pz };
      }
    }
    // No sidewalk near: the nearest clear ground will do.
    if (ground && rad >= GROUND_REACH) return ground;
  }
  return ground;
}
