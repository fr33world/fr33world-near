/**
 * Villas along the hill roads (owner's reference, 2026-10-29: villas on the hillsides). Each
 * stands on a level pad at the height of the road in front of it, so its drive runs level to
 * the road; the terrain is cut and filled to the pad as it is to the roads (`Grading`).
 *
 * Buildings are axis-aligned and their fronts face north or south (homes.ts), so villas go
 * along the stretches that run mostly east–west (most of them: the roads follow the contours),
 * on either side, set back from the road, clear of every road's shoulders, of each other and
 * of the lake,
 * and only where the hillside is gentle enough that the pad isn't a cliff of cut or fill.
 */
import { HILL_HALF, type HillRoad } from './hillroads.ts';
import { coastDistance, inside, lakeEdgeDistance, QUARRY } from './plan.ts';
import type { RampPoint } from './ramps.ts';
import { hash2, rng } from './random.ts';

export interface HillVilla {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** The pad's level (the road's height in front). */
  y: number;
  /** Its front faces north (towards smaller z), and its drive runs to the road at z = `toZ`. */
  north: boolean;
  toZ: number;
  seed: number;
}

/** A level pad the terrain is graded to: a capsule round the segment ab, `flat` m wide. */
export interface Pad {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  y: number;
  flat: number;
}

/** Distance between villas along a road (m), and the setback from the road's shoulder. */
const SPACING = 34;
const SETBACK = 9;
/** Garden round the house that is level with it (m). */
const GARDEN = 2;
/** The road's level ground either side of its centreline (hillroads.ts: half plus shoulder). */
const ROAD_FLAT = HILL_HALF + 2.5;
/** Most the natural ground under a pad may lie above or below it (m). */
const MAX_CUT = 9;

/** The pad a villa stands on: round its longer axis, wide enough to hold the house and garden. */
export function villaPad(v: HillVilla): Pad {
  const long = Math.max(v.w, v.d) / 2;
  const short = Math.min(v.w, v.d) / 2;
  const along = long - short;
  const [dx, dz] = v.w >= v.d ? [along, 0] : [0, along];
  return {
    ax: v.x - dx,
    az: v.z - dz,
    bx: v.x + dx,
    bz: v.z + dz,
    y: v.y,
    flat: short * Math.SQRT2 + GARDEN,
  };
}

/** Distance from (x, z) to segment ab. */
function toSegment(ax: number, az: number, bx: number, bz: number, x: number, z: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

export function placeVillas(
  roads: readonly HillRoad[],
  ground: (x: number, z: number) => number,
  keepClear: (x: number, z: number) => boolean,
  seed: number,
): HillVilla[] {
  const villas: HillVilla[] = [];
  const pads: Pad[] = [];
  /** How far the pad's level ground keeps from every road's centreline (checked every 2 m). */
  const roadGap = (p: Pad) => {
    let best = Infinity;
    for (const r of roads) {
      for (let i = 1; i < r.points.length; i += 1) {
        const a = r.points[i - 1] as RampPoint;
        const b = r.points[i] as RampPoint;
        for (const [x, z] of [
          [a.x, a.z],
          [(a.x + b.x) / 2, (a.z + b.z) / 2],
        ] as const)
          best = Math.min(best, toSegment(p.ax, p.az, p.bx, p.bz, x, z));
      }
    }
    return best - p.flat - 0.5;
  };
  roads.forEach((road, ri) => {
    const pts = road.points;
    const r = rng(hash2(seed, 0x7111a + ri));
    let walked = 0;
    let next = 30;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1] as RampPoint;
      const b = pts[i] as RampPoint;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      walked += len;
      if (walked < next) continue;
      next = walked + SPACING;
      const dx = (b.x - a.x) / len;
      // Fronts face north or south: only along stretches running mostly east–west.
      if (Math.abs(dx) < 0.8) continue;
      for (const side of [-1, 1]) {
        if (!r.chance(0.8)) continue;
        const w = r.range(16, 24);
        const d = r.range(12, 16);
        // South of the road (side +1) the front faces north, back towards it.
        const off = (ROAD_FLAT + SETBACK + d / 2) / Math.abs(dx);
        const v: HillVilla = {
          x: b.x,
          z: b.z + side * off,
          w,
          d,
          h: r.range(7, 10),
          y: b.y,
          north: side > 0,
          toZ: b.z,
          seed: hash2(seed, 0x7112 + villas.length),
        };
        const pad = villaPad(v);
        if (roadGap(pad) < ROAD_FLAT) continue;
        const crowds = (o: Pad) =>
          Math.min(
            toSegment(o.ax, o.az, o.bx, o.bz, pad.ax, pad.az),
            toSegment(o.ax, o.az, o.bx, o.bz, pad.bx, pad.bz),
          ) <
          o.flat + pad.flat + 4;
        if (pads.some(crowds)) continue;
        // The ground round the pad's edge, and clear of the coast, quarry, lake and terrace.
        let ok = true;
        for (let k = 0; k < 16 && ok; k += 1) {
          const ang = (k / 16) * Math.PI * 2;
          const [cx, cz] = k % 2 ? [pad.ax, pad.az] : [pad.bx, pad.bz];
          const x = cx + Math.cos(ang) * pad.flat;
          const z = cz + Math.sin(ang) * pad.flat;
          ok =
            Math.abs(ground(x, z) - v.y) <= MAX_CUT &&
            !keepClear(x, z) &&
            coastDistance(x, z) > 60 &&
            !inside(QUARRY, x, z) &&
            lakeEdgeDistance(x, z) > 40;
        }
        if (!ok) continue;
        villas.push(v);
        pads.push(pad);
      }
    }
  });
  return villas;
}
