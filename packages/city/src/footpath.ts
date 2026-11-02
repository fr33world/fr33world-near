/**
 * Ways on foot (owner, 2026-10-31): someone walking isn't held to the streets, so a place a few
 * metres away is a few metres away and not a lap of the plaza. Close by, the way is a straight
 * line if nothing stands in it, or else a search of the ground around the two ends, pulled
 * tight; it wins when it saves enough over the road. Further off the way is still the roads
 * (RoadGraph), only without the part of each end a short walk across open ground does better.
 * Cars keep to RoadGraph, and so does the server's pay, so neither sees any of this.
 *
 * What stops a body here is what the server's walls know (CollisionIndex), the fountain, and
 * whatever the caller adds; the ground is judged in patches, remembered from one plan to the
 * next since the terrain and coast are slow to ask about and a phone plans every few seconds.
 */
import { CollisionIndex, type Solid2D } from './collision.ts';
import type { CityLayout } from './layout.ts';
import { inside, isWalkable, RIVER } from './plan.ts';
import type { Ramp, RampPoint } from './ramps.ts';
import { Heap, type RoadGraph, type Route, STEP } from './roadgraph.ts';
import { terrainHeight } from './terrain.ts';

/** Two ends further apart than this (m) aren't searched: that's a trip for the roads. */
const NEAR = 260;
/** A way off the road must be at most this much of the road's length to be taken. */
const WORTH = 0.8;
/** The search's squares (m): each keeps ROOM clear of solids, so a wall can't slip between two. */
const CELL = 2;
const ROOM = 1;
/** How much clear a straight leg needs either side (m). */
const BODY = 0.5;
/** Squares looked at round the two ends: at least PAD metres, and the most ever visited. */
const PAD = 40;
const MOST_VISITED = 5000;
/** How far from an end to look for a square to stand on (a door beside a wall, in squares). */
const SNAP = 3;
/** The ground's patches (m), and the steepest climb that's a way to send someone (tan 35°). */
const PATCH = 8;
const STEEPEST = 0.7;
/** A patch is too steep, all open, or by the water: there each spot is asked about, slowly. */
const STEEP = 0;
const OPEN = 1;
const SHORE = 2;
/** Ground this far under the sea's level is the sea bed or beside it (m). */
const SEA_BED = -1;
/** A ramp is a wall to someone beside it from this height, and a roof from the next (m). */
const RAMP_FROM = 0.6;
const RAMP_TO = 4;
/** Ends of a road route within this straight line (m) can be walked to across open ground. */
const REACH = 150;
const CUT_SCAN = 64;
/** Legs longer than STEP are split into this many metres (the ribbon redraws at each point). */
const SPACING = 6;

/** The plaza fountain's basin (m; physics.ts). */
export const FOUNTAIN_RADIUS = 9.4;

type Point = [number, number];

/** A circle as boxes: three of them, a stepped disc just inside it. */
function discBoxes(x: number, z: number, r: number): Solid2D[] {
  return [
    [1, 0.42],
    [0.71, 0.71],
    [0.42, 1],
  ].map(([a, b]) => {
    const [hx, hz] = [(a as number) * r, (b as number) * r];
    return { x0: x - hx, x1: x + hx, z0: z - hz, z1: z + hz };
  });
}

/** The stretches of a ramp too high to step on and too low to walk under, as boxes. */
function rampBoxes(ramp: Ramp): Solid2D[] {
  const boxes: Solid2D[] = [];
  const half = ramp.width / 2;
  for (let i = 1; i < ramp.points.length; i += 1) {
    const a = ramp.points[i - 1] as RampPoint;
    const b = ramp.points[i] as RampPoint;
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / half);
    for (let k = 0; k <= n; k += 1) {
      const y = a.y + ((b.y - a.y) * k) / n;
      if (y < RAMP_FROM || y > RAMP_TO) continue;
      const x = a.x + ((b.x - a.x) * k) / n;
      const z = a.z + ((b.z - a.z) * k) / n;
      boxes.push({ x0: x - half, x1: x + half, z0: z - half, z1: z + half });
    }
  }
  return boxes;
}

function lengthOf(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [ax, az] = points[i - 1] as Point;
    const [bx, bz] = points[i] as Point;
    total += Math.hypot(bx - ax, bz - az);
  }
  return total;
}

/** No leg past STEP without a point every SPACING metres. */
function spaced(points: readonly Point[]): Point[] {
  const out: Point[] = [points[0] as Point];
  for (let i = 1; i < points.length; i += 1) {
    const [ax, az] = points[i - 1] as Point;
    const [bx, bz] = points[i] as Point;
    const len = Math.hypot(bx - ax, bz - az);
    const n = len > STEP ? Math.ceil(len / SPACING) : 1;
    for (let k = 1; k <= n; k += 1) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

export class Footpaths {
  private readonly city: CityLayout;
  private readonly roads: RoadGraph;
  private readonly solids: CollisionIndex;
  private readonly patches = new Map<number, number>();

  /** `extra`: what else stands in the way, for what only the client places (benches and so on). */
  constructor(city: CityLayout, roads: RoadGraph, extra: readonly Solid2D[] = []) {
    this.city = city;
    this.roads = roads;
    const p = city.plaza;
    this.solids = new CollisionIndex([
      ...CollisionIndex.fromCity(city).boxes,
      ...discBoxes((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, FOUNTAIN_RADIUS),
      ...city.ramps.flatMap(rampBoxes),
      ...extra,
    ]);
  }

  /** The way on foot from (ax, az) to (bx, bz); null when either is far from a road or a way. */
  route(ax: number, az: number, bx: number, bz: number): Route | null {
    const road = this.roads.route(ax, az, bx, bz);
    const a: Point = [ax, az];
    const b: Point = [bx, bz];
    const straight = Math.hypot(bx - ax, bz - az);
    // Getting onto the road and off it again are straight lines nobody has looked along: when
    // one crosses a wall or the sea, the road is no measure of anything.
    const honest = road && this.ends(road.points);
    const most = honest ? Math.min(road.length * WORTH, NEAR * 2) : NEAR * 2;
    if (straight <= NEAR && straight < most) {
      const walk = this.clear(a, b) ? [a, b] : this.search(a, b, most);
      if (walk && lengthOf(walk) < most)
        return { points: spaced(walk), length: lengthOf(walk), offRoad: true };
    }
    if (!road) return null;
    const way = this.trimmed(road.points);
    return { points: spaced(way), length: lengthOf(way) };
  }

  /** True when a road route's first and last legs can be walked. */
  private ends(points: readonly Point[]): boolean {
    const n = points.length;
    return (
      this.clear(points[0] as Point, points[1] as Point) &&
      this.clear(points[n - 2] as Point, points[n - 1] as Point)
    );
  }

  /** A road route, without the start and end that open ground does better. */
  private trimmed(points: readonly Point[]): Point[] {
    return this.cutStart(this.cutStart(points).reverse()).reverse();
  }

  /** Straight from the start to the furthest of the first points that saves enough. */
  private cutStart(points: readonly Point[]): Point[] {
    const start = points[0] as Point;
    const along = [0];
    const last = Math.min(points.length - 1, CUT_SCAN);
    for (let k = 1; k <= last; k += 1) {
      const [ax, az] = points[k - 1] as Point;
      const [bx, bz] = points[k] as Point;
      along.push((along[k - 1] as number) + Math.hypot(bx - ax, bz - az));
    }
    for (let k = last; k >= 2; k -= 1) {
      const p = points[k] as Point;
      const d = Math.hypot(p[0] - start[0], p[1] - start[1]);
      if (d <= REACH && d <= (along[k] as number) * WORTH && this.clear(start, p))
        return [start, ...points.slice(k)];
    }
    return [...points];
  }

  /** True when a body can go straight from a to b (their own spots aren't judged). */
  private clear(a: Point, b: Point): boolean {
    if (this.solids.segmentBlocked(a[0], a[1], b[0], b[1], BODY)) return false;
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / CELL);
    for (let k = 1; k < n; k += 1)
      if (!this.ground(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n))
        return false;
    return true;
  }

  /** Ground to send someone over. The channel's edges want a closer look than a patch's. */
  private ground(x: number, z: number): boolean {
    if (inside(RIVER, x, z) && !this.onBridge(x, z)) return false;
    const cx = Math.round(x / PATCH);
    const cz = Math.round(z / PATCH);
    const k = patchKey(cx, cz);
    let patch = this.patches.get(k);
    if (patch === undefined) {
      patch = this.judged(cx, cz);
      this.patches.set(k, patch);
    }
    return patch === SHORE ? isWalkable(x, z) : patch === OPEN;
  }

  private onBridge(x: number, z: number): boolean {
    return this.city.bridges.some((b) => x >= b.x0 && x <= b.x1 && Math.abs(z - b.z) <= b.half);
  }

  /** What a patch is, from its height and the four around it. */
  private judged(cx: number, cz: number): number {
    const x = cx * PATCH;
    const z = cz * PATCH;
    const y = terrainHeight(x, z);
    let lowest = y;
    for (const [nx, nz] of [
      [x + PATCH, z],
      [x - PATCH, z],
      [x, z + PATCH],
      [x, z - PATCH],
    ] as const) {
      const h = terrainHeight(nx, nz);
      if (Math.abs(h - y) > PATCH * STEEPEST) return STEEP;
      lowest = Math.min(lowest, h);
    }
    return lowest < SEA_BED || !isWalkable(x, z) ? SHORE : OPEN;
  }

  /** A* over squares between the two ends, pulled tight; null when it would pass `most` metres. */
  private search(a: Point, b: Point, most: number): Point[] | null {
    const pad = Math.max(PAD, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.4);
    const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL) * CELL;
    const z0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL) * CELL;
    const w = Math.ceil((Math.max(a[0], b[0]) + pad - x0) / CELL) + 1;
    const h = Math.ceil((Math.max(a[1], b[1]) + pad - z0) / CELL) + 1;
    // 0 not looked at yet, 1 free, 2 not.
    const seen = new Uint8Array(w * h);
    const free = (i: number, j: number): boolean => {
      if (i < 0 || j < 0 || i >= w || j >= h) return false;
      const c = i + j * w;
      if (seen[c] === 0) {
        const [x, z] = [x0 + i * CELL, z0 + j * CELL];
        seen[c] = !this.solids.pointBlocked(x, z, ROOM) && this.ground(x, z) ? 1 : 2;
      }
      return seen[c] === 1;
    };
    /** The nearest free square to a spot, near enough to walk the rest. */
    const snap = (p: Point): number => {
      const i0 = Math.round((p[0] - x0) / CELL);
      const j0 = Math.round((p[1] - z0) / CELL);
      for (let r = 0; r <= SNAP; r += 1)
        for (let i = i0 - r; i <= i0 + r; i += 1)
          for (let j = j0 - r; j <= j0 + r; j += 1)
            if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) === r && free(i, j)) return i + j * w;
      return -1;
    };
    const start = snap(a);
    const goal = snap(b);
    if (start < 0 || goal < 0) return null;
    const gi = goal % w;
    const gj = Math.floor(goal / w);
    const left = (i: number, j: number) => {
      const dx = Math.abs(i - gi);
      const dz = Math.abs(j - gj);
      return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * CELL;
    };
    const cost = new Float32Array(w * h).fill(Infinity);
    const from = new Int32Array(w * h).fill(-1);
    const done = new Uint8Array(w * h);
    const open = new Heap();
    cost[start] = 0;
    open.push(start, left(start % w, Math.floor(start / w)));
    // Squares run a little longer than the line they pull tight to.
    const limit = most * 1.1;
    let visited = 0;
    while (open.size > 0) {
      const c = open.pop();
      if (done[c]) continue;
      done[c] = 1;
      if (c === goal) break;
      visited += 1;
      const i = c % w;
      const j = Math.floor(c / w);
      if ((cost[c] as number) + left(i, j) > limit || visited > MOST_VISITED) return null;
      for (let dz = -1; dz <= 1; dz += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx === 0 && dz === 0) || !free(i + dx, j + dz)) continue;
          // Not through the corner between two solids.
          if (dx !== 0 && dz !== 0 && !(free(i + dx, j) && free(i, j + dz))) continue;
          const n = i + dx + (j + dz) * w;
          const next = (cost[c] as number) + CELL * (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1);
          if (next < (cost[n] as number)) {
            cost[n] = next;
            from[n] = c;
            open.push(n, next + left(i + dx, j + dz));
          }
        }
    }
    if (!done[goal]) return null;
    const path: Point[] = [b];
    for (let c = goal; c >= 0; c = from[c] as number)
      path.push([x0 + (c % w) * CELL, z0 + Math.floor(c / w) * CELL]);
    path.push(a);
    return this.tight(path.reverse());
  }

  /** The fewest straight legs along a path of squares. */
  private tight(path: readonly Point[]): Point[] {
    const out: Point[] = [path[0] as Point];
    let i = 0;
    while (i < path.length - 1) {
      let j = i + 1;
      while (j + 1 < path.length && this.clear(path[i] as Point, path[j + 1] as Point)) j += 1;
      out.push(path[j] as Point);
      i = j;
    }
    return out;
  }
}

const patchKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
