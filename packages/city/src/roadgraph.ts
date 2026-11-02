/**
 * The road graph (Phase 6): routes along the city's streets and hill roads, for waypoints that
 * follow roads (the client) and pay by road distance (the world server's jobs). Every road's
 * centreline is sampled every STEP metres and linked along the road; samples of different roads
 * closer than JOIN are linked too, which finds every junction and every hill road joining the
 * grid without special cases. Routes are A* over that graph, entered and left at the road
 * points nearest the two ends. Freeways aren't in it (their ramps would need their own links).
 */
import type { CityLayout } from './layout.ts';

/** Apart along a road (m). */
export const STEP = 16;
const JOIN = 12;
const CELL = 32;

export interface Route {
  /** From the start to the destination (x, z), road points in between. */
  points: [number, number][];
  /** Its length along the roads, ends included (m). */
  length: number;
  /** It leaves the roads (footpath.ts): someone following it needn't be planned for again. */
  offRoad?: boolean;
}

export class RoadGraph {
  readonly x: Float64Array;
  readonly z: Float64Array;
  private readonly links: number[][];
  private readonly grid = new Map<number, number[]>();

  private constructor(points: [number, number][], links: number[][]) {
    this.x = Float64Array.from(points, (p) => p[0]);
    this.z = Float64Array.from(points, (p) => p[1]);
    this.links = links;
    points.forEach(([x, z], i) => {
      const k = this.cell(x, z);
      const list = this.grid.get(k);
      if (list) list.push(i);
      else this.grid.set(k, [i]);
    });
  }

  get size(): number {
    return this.x.length;
  }

  static fromCity(city: CityLayout): RoadGraph {
    const points: [number, number][] = [];
    const links: number[][] = [];
    const road: number[] = [];
    const add = (x: number, z: number, r: number) => {
      const i = points.length;
      points.push([x, z]);
      links.push([]);
      road.push(r);
      return i;
    };
    const link = (a: number, b: number) => {
      if (a === b || (links[a] as number[]).includes(b)) return;
      (links[a] as number[]).push(b);
      (links[b] as number[]).push(a);
    };
    let r = 0;
    for (const s of city.roads) {
      const n = Math.max(1, Math.round((s.to - s.from) / STEP));
      let prev = -1;
      for (let k = 0; k <= n; k += 1) {
        const along = s.from + ((s.to - s.from) * k) / n;
        const i = s.axis === 'ns' ? add(s.center, along, r) : add(along, s.center, r);
        if (prev >= 0) link(prev, i);
        prev = i;
      }
      r += 1;
    }
    for (const h of city.hillRoads) {
      let prev = -1;
      let walked = Infinity;
      h.points.forEach((p, k) => {
        const last = k === h.points.length - 1;
        const q = h.points[k - 1];
        walked += q ? Math.hypot(p.x - q.x, p.z - q.z) : 0;
        if (walked < STEP && !last) return;
        walked = 0;
        const i = add(p.x, p.z, r);
        if (prev >= 0) link(prev, i);
        prev = i;
      });
      r += 1;
    }
    // Junctions: samples of different roads close together.
    const g = new RoadGraph(points, links);
    for (let i = 0; i < points.length; i += 1) {
      const [x, z] = points[i] as [number, number];
      for (const j of g.near(x, z, JOIN))
        if (j > i && road[j] !== road[i]) {
          link(i, j);
        }
    }
    return g;
  }

  private cell(x: number, z: number): number {
    return (Math.floor(x / CELL) + 2048) * 4096 + (Math.floor(z / CELL) + 2048);
  }

  /** Points within `r` of (x, z). */
  private near(x: number, z: number, r: number): number[] {
    const out: number[] = [];
    const c0 = Math.floor((x - r) / CELL);
    const c1 = Math.floor((x + r) / CELL);
    const d0 = Math.floor((z - r) / CELL);
    const d1 = Math.floor((z + r) / CELL);
    for (let cx = c0; cx <= c1; cx += 1)
      for (let cz = d0; cz <= d1; cz += 1)
        for (const i of this.grid.get((cx + 2048) * 4096 + (cz + 2048)) ?? [])
          if (Math.hypot((this.x[i] as number) - x, (this.z[i] as number) - z) <= r) out.push(i);
    return out;
  }

  /** The road point nearest (x, z), or -1 when none is within `max` metres. */
  nearest(x: number, z: number, max = 400): number {
    for (let r = CELL; r <= max * 2; r *= 2) {
      let best = -1;
      let d = Infinity;
      for (const i of this.near(x, z, Math.min(r, max))) {
        const e = Math.hypot((this.x[i] as number) - x, (this.z[i] as number) - z);
        if (e < d) {
          d = e;
          best = i;
        }
      }
      if (best >= 0) return best;
      if (r >= max) break;
    }
    return -1;
  }

  /** The way along the roads from (ax, az) to (bx, bz); null when either is far from a road. */
  route(ax: number, az: number, bx: number, bz: number): Route | null {
    const start = this.nearest(ax, az);
    const goal = this.nearest(bx, bz);
    if (start < 0 || goal < 0) return null;
    const gx = this.x[goal] as number;
    const gz = this.z[goal] as number;
    const n = this.size;
    const cost = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const open = new Heap();
    const closed = new Uint8Array(n);
    cost[start] = 0;
    open.push(start, Math.hypot((this.x[start] as number) - gx, (this.z[start] as number) - gz));
    while (open.size > 0) {
      const i = open.pop();
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === goal) break;
      const xi = this.x[i] as number;
      const zi = this.z[i] as number;
      for (const j of this.links[i] as number[]) {
        const xj = this.x[j] as number;
        const zj = this.z[j] as number;
        const c = (cost[i] as number) + Math.hypot(xj - xi, zj - zi);
        if (c < (cost[j] as number)) {
          cost[j] = c;
          from[j] = i;
          open.push(j, c + Math.hypot(xj - gx, zj - gz));
        }
      }
    }
    if (!Number.isFinite(cost[goal])) return null;
    const path: [number, number][] = [];
    for (let i = goal; i >= 0; i = from[i] as number)
      path.push([this.x[i] as number, this.z[i] as number]);
    path.reverse();
    const first = path[0] as [number, number];
    const last = path.at(-1) as [number, number];
    const length =
      (cost[goal] as number) +
      Math.hypot(first[0] - ax, first[1] - az) +
      Math.hypot(last[0] - bx, last[1] - bz);
    return { points: [[ax, az], ...path, [bx, bz]], length };
  }
}

/** A binary min-heap of node indices by priority (a node may be in it more than once). */
export class Heap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] as number) <= key) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0] as number;
    const lastItem = this.items.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && (this.keys[l] as number) < (this.keys[m] as number)) m = l;
        if (r < this.items.length && (this.keys[r] as number) < (this.keys[m] as number)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b] as number, this.items[a] as number];
    [this.keys[a], this.keys[b]] = [this.keys[b] as number, this.keys[a] as number];
  }
}
