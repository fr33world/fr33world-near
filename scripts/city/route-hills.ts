/**
 * Routes the hill roads (packages/city/src/hillroads.ts) over the natural ground and prints
 * their control points, to paste into HILL_ROAD_SPECS when the terrain or the routes change.
 *
 *   node scripts/city/route-hills.ts [name]   (one route only: the others aren't re-routed)
 *
 * Each route is a least-cost path on an 8 m grid whose state is (cell, heading): a step may
 * turn by one heading at most, so bends and hairpins keep a radius a car can take. Steps cost
 * their length, more where they climb faster than a road should, cross a steep hillside (deep
 * cuts), or run near another road; so routes follow the contours and switch back where the
 * slope is steep. Paths are then smoothed and thinned to control points, and each road's
 * profile is checked: steepest grade, deepest cut and highest fill.
 */
import {
  coastDistance,
  HILL_GRADE,
  type HillRoadSpec,
  inside,
  isLand,
  lakeEdgeDistance,
  landOutline,
  makeHillRoads,
  naturalHeight,
  OBSERVATORY_AT,
  QUARRY,
} from '../../packages/city/src/index.ts';

interface Route {
  name: string;
  /** A city street's end at the hills' edge (x), or a point to start from. */
  from: [number, number];
  to: [number, number];
  /** The hill road it starts from (`from` is then near it), and the one it ends on. */
  leaves?: string;
  joins?: string;
  /** Waypoints to pass near, in order (routed leg by leg). */
  via?: [number, number][];
  /**
   * Not searched: the coast offset inland by this many metres (just behind the beach),
   * smoothed, from street end `from` to street end `to` the long way round the north.
   */
  coast?: number;
}

const EDGE_Z = -840;

const ROUTES: Route[] = [
  // Sol Boulevard carries on up the hill, switching back twice, to the observatory's terrace.
  {
    name: 'Observatory Road',
    from: [0, EDGE_Z],
    via: [
      [-150, -960],
      [100, -1040],
    ],
    to: [OBSERVATORY_AT.x, OBSERVATORY_AT.z + 56],
  },
  // From Vista Street up into the west hills and east along them to Observatory Road.
  {
    name: 'Crest Drive',
    from: [-960, EDGE_Z],
    to: [OBSERVATORY_AT.x - 60, OBSERVATORY_AT.z + 70],
    joins: 'Observatory Road',
  },
  { name: 'Mirador Drive', from: [-480, EDGE_Z], to: [-600, -980], joins: 'Crest Drive' },
  // Along the hills east from Observatory Road's second hairpin to above the lake.
  {
    name: 'Sycamore Drive',
    leaves: 'Observatory Road',
    from: [280, -1060],
    to: [690, -1090],
  },
  // From Camino Real up to Sycamore Drive.
  { name: 'Lago Drive', from: [480, EDGE_Z], to: [610, -1090], joins: 'Sycamore Drive' },
  { name: 'Quarry Road', from: [1080, EDGE_Z], to: [1180, -1040] },
  // From Ocean Avenue up the Pacific side, along the north shore under the cliffs, and down
  // the east shore to Orchard Avenue.
  { name: 'Coast Road', from: [-1200, EDGE_Z], to: [1440, EDGE_Z], coast: 46 },
];

const G = 8;
const X0 = -1272;
const X1 = 1464;
const Z0 = -1312;
const Z1 = EDGE_Z;
const NX = Math.round((X1 - X0) / G) + 1;
const NZ = Math.round((Z1 - Z0) / G) + 1;
const DIRS: [number, number][] = [
  [0, -1],
  [1, -2],
  [1, -1],
  [2, -1],
  [1, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 1],
  [-1, 2],
  [-1, 1],
  [-2, 1],
  [-1, 0],
  [-2, -1],
  [-1, -1],
  [-1, -2],
];
const ND = DIRS.length;

const hs = new Float64Array(NX * NZ);
const slope = new Float64Array(NX * NZ);
const open = new Uint8Array(NX * NZ);
for (let j = 0; j < NZ; j += 1) {
  for (let i = 0; i < NX; i += 1) {
    const x = X0 + i * G;
    const z = Z0 + j * G;
    const k = j * NX + i;
    hs[k] = naturalHeight(x, z);
    const gx = (naturalHeight(x + 4, z) - naturalHeight(x - 4, z)) / 8;
    const gz = (naturalHeight(x, z + 4) - naturalHeight(x, z - 4)) / 8;
    slope[k] = Math.hypot(gx, gz);
    // Kept clear of the lake, its rim and its banks.
    const lake = lakeEdgeDistance(x, z) < 40;
    open[k] = isLand(x, z) && coastDistance(x, z) > 60 && !lake ? 1 : 0;
  }
}

/** Distance to the nearest road routed so far (on the grid), for keeping roads apart. */
const nearRoad = new Float64Array(NX * NZ).fill(Infinity);
function markRoad(path: [number, number][]) {
  for (const [x, z] of path) {
    const ci = Math.round((x - X0) / G);
    const cj = Math.round((z - Z0) / G);
    for (let dj = -6; dj <= 6; dj += 1) {
      for (let di = -6; di <= 6; di += 1) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= NX || j >= NZ) continue;
        const k = j * NX + i;
        nearRoad[k] = Math.min(nearRoad[k] as number, Math.hypot(X0 + i * G - x, Z0 + j * G - z));
      }
    }
  }
}

class Heap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((keys[p] as number) <= key) break;
      keys[i] = keys[p] as number;
      vals[i] = vals[p] as number;
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop(): number {
    const { keys, vals } = this;
    const top = vals[0] as number;
    const lastK = keys.pop() as number;
    const lastV = vals.pop() as number;
    if (keys.length > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= keys.length) break;
        const r = l + 1;
        const c = r < keys.length && (keys[r] as number) < (keys[l] as number) ? r : l;
        if ((keys[c] as number) >= lastK) break;
        keys[i] = keys[c] as number;
        vals[i] = vals[c] as number;
        i = c;
      }
      keys[i] = lastK;
      vals[i] = lastV;
    }
    return top;
  }
}

/** Radius of a hairpin (m) and what one costs besides its length (keeps them few). */
const HAIRPIN_R = 20;
const HAIRPIN_COST = 150;

/** Cost of a stretch of road `len` m long climbing `rise` m. */
function climbCost(len: number, rise: number): number {
  return len * (1 + 3 * (Math.abs(rise) / len / 0.1) ** 4);
}

/** Where a hairpin from (x, z) heading `d`, turning to `side` (+1 left of travel), lands. */
function hairpinEnd(x: number, z: number, d: number, side: number): [number, number] {
  const [di, dj] = DIRS[d] as [number, number];
  const n = Math.hypot(di, dj);
  return [x - (dj / n) * side * 2 * HAIRPIN_R, z + (di / n) * side * 2 * HAIRPIN_R];
}

/**
 * Points round a hairpin from (x, z) heading `d` to (lx, lz) (its landing, on the grid): half
 * an ellipse bulging `HAIRPIN_R` forward, leaving and arriving along the heading.
 */
function hairpin(x: number, z: number, d: number, lx: number, lz: number): [number, number][] {
  const [di, dj] = DIRS[d] as [number, number];
  const n = Math.hypot(di, dj);
  const [hx, hz] = [di / n, dj / n];
  const [cx, cz] = [(x + lx) / 2, (z + lz) / 2];
  const [px, pz] = [(lx - x) / 2, (lz - z) / 2];
  const out: [number, number][] = [];
  for (let k = 1; k < 12; k += 1) {
    const a = (Math.PI * k) / 12;
    out.push([
      cx - px * Math.cos(a) + hx * HAIRPIN_R * Math.sin(a),
      cz - pz * Math.cos(a) + hz * HAIRPIN_R * Math.sin(a),
    ]);
  }
  return out;
}

/**
 * Least-cost path from `a` (heading `dir0`) to within two cells of `b`; grid points. Besides
 * steps (turning by a heading at most), a hairpin turns back on itself round a half circle:
 * on a steep slope its apex points uphill for a few metres, which steps alone would price as a
 * road that steep, and the route would wander off to climb somewhere flatter instead.
 */
function search(a: [number, number], dir0: number, b: [number, number], quarry: boolean) {
  const cellOf = (x: number, z: number) => [Math.round((x - X0) / G), Math.round((z - Z0) / G)];
  const [ai, aj] = cellOf(...a) as [number, number];
  const [bi, bj] = cellOf(...b) as [number, number];
  const n = NX * NZ * ND;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  /** How each state was reached: 0 a step, ±1 a hairpin (to that side). */
  const via = new Int8Array(n);
  const heap = new Heap();
  const s0 = (aj * NX + ai) * ND + dir0;
  cost[s0] = 0;
  heap.push(0, s0);
  const bx = X0 + bi * G;
  const bz = Z0 + bj * G;
  const at = (st: number): [number, number] => {
    const kk = Math.floor(st / ND);
    return [X0 + (kk % NX) * G, Z0 + Math.floor(kk / NX) * G];
  };
  const usable = (x: number, z: number) => {
    const i = Math.round((x - X0) / G);
    const j = Math.round((z - Z0) / G);
    if (i < 0 || j < 0 || i >= NX || j >= NZ || !open[j * NX + i]) return false;
    return quarry || !inside(QUARRY, x, z);
  };
  const crowded = (x: number, z: number) => {
    const i = Math.round((x - X0) / G);
    const j = Math.round((z - Z0) / G);
    const nearEnds = Math.hypot(x - bx, z - bz) < 64 || Math.hypot(x - a[0], z - a[1]) < 64;
    return !nearEnds && (nearRoad[j * NX + i] as number) < 36;
  };
  while (heap.size > 0) {
    const s = heap.pop();
    const d = s % ND;
    const k = (s - d) / ND;
    const i = k % NX;
    const j = (k - i) / NX;
    if (Math.abs(i - bi) <= 2 && Math.abs(j - bj) <= 2) {
      const out: [number, number][] = [];
      for (let t = s; t !== -1; t = from[t] as number) {
        out.push(at(t));
        const side = via[t] as number;
        if (side !== 0) {
          const p = from[t] as number;
          out.push(...hairpin(...at(p), p % ND, ...at(t)).reverse());
        }
      }
      return out.reverse();
    }
    const c = cost[s] as number;
    const relax = (ns: number, step: number, side: number) => {
      const nc = c + step;
      if (nc < (cost[ns] as number)) {
        cost[ns] = nc;
        from[ns] = s;
        via[ns] = side;
        const [x, z] = at(ns);
        heap.push(nc + Math.hypot(x - bx, z - bz), ns);
      }
    };
    for (const turn of [-1, 0, 1]) {
      const nd = (d + turn + ND) % ND;
      const [di, dj] = DIRS[nd] as [number, number];
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
      const nk = nj * NX + ni;
      const x = X0 + ni * G;
      const z = Z0 + nj * G;
      if (!usable(x, z)) continue;
      const len = Math.hypot(di, dj) * G;
      const h0 = hs[k] as number;
      const h1 = hs[nk] as number;
      const mid = naturalHeight(x - (di * G) / 2, z - (dj * G) / 2);
      let step = climbCost(len, h1 - h0);
      step += len * 3 * Math.max(0, (slope[nk] as number) - 0.45) ** 2;
      step += Math.abs(mid - (h0 + h1) / 2);
      step += Math.abs(turn) * 8;
      if (crowded(x, z)) continue;
      relax(nk * ND + nd, step, 0);
    }
    for (const side of [-1, 1]) {
      const [x0, z0] = at(s);
      const [ex, ez] = cellOf(...hairpinEnd(x0, z0, d, side)) as [number, number];
      const [lx, lz] = [X0 + ex * G, Z0 + ez * G];
      const arc = hairpin(x0, z0, d, lx, lz);
      if (!usable(lx, lz) || !arc.every(([x, z]) => usable(x, z) && !crowded(x, z))) continue;
      const len = Math.PI * HAIRPIN_R;
      const step = climbCost(len, (hs[ez * NX + ex] as number) - (hs[k] as number)) + HAIRPIN_COST;
      relax((ez * NX + ex) * ND + ((d + ND / 2) % ND), step, side);
    }
  }
  throw new Error(`no route from ${a.join(', ')} to ${b.join(', ')}`);
}

/** Chaikin corner cutting, keeping the ends. */
function chaikin(p: [number, number][], times: number): [number, number][] {
  let out = p;
  for (let t = 0; t < times; t += 1) {
    const next: [number, number][] = [out[0] as [number, number]];
    for (let i = 0; i < out.length - 1; i += 1) {
      const [ax, az] = out[i] as [number, number];
      const [bx, bz] = out[i + 1] as [number, number];
      next.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    next.push(out[out.length - 1] as [number, number]);
    out = next;
  }
  return out;
}

/** Douglas–Peucker thinning to `tol` m. */
function thin(p: [number, number][], tol: number): [number, number][] {
  if (p.length < 3) return p;
  const [ax, az] = p[0] as [number, number];
  const [bx, bz] = p[p.length - 1] as [number, number];
  let worst = 0;
  let at = 0;
  for (let i = 1; i < p.length - 1; i += 1) {
    const [x, z] = p[i] as [number, number];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const d = Math.abs((x - ax) * dz - (z - az) * dx) / len;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tol) return [p[0] as [number, number], p[p.length - 1] as [number, number]];
  return [...thin(p.slice(0, at + 1), tol).slice(0, -1), ...thin(p.slice(at), tol)];
}

/**
 * The coast offset `d` m inland and smoothed, from the street end `from` round the north to
 * `to`: the coastline sampled every 8 m, each sample moved inland along the shore's normal,
 * averaged along the way (so convex corners become wide bends), joined to the street ends.
 */
function coastRoute(from: [number, number], to: [number, number], d: number): [number, number][] {
  const coast = landOutline();
  const samples: [number, number][] = [];
  for (let i = 0; i < coast.length; i += 1) {
    const [ax, az] = coast[i] as [number, number];
    const [bx, bz] = coast[(i + 1) % coast.length] as [number, number];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 8);
    for (let k = 0; k < n; k += 1)
      samples.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  const m = samples.length;
  const inland = samples.map(([x, z], i) => {
    const [px, pz] = samples[(i - 1 + m) % m] as [number, number];
    const [qx, qz] = samples[(i + 1) % m] as [number, number];
    const len = Math.hypot(qx - px, qz - pz) || 1;
    let [nx, nz] = [-(qz - pz) / len, (qx - px) / len];
    if (!isLand(x + nx * 10, z + nz * 10)) [nx, nz] = [-nx, -nz];
    return [x + nx * d, z + nz * d] as [number, number];
  });
  let line = inland;
  for (let pass = 0; pass < 6; pass += 1) {
    line = line.map((_, i) => {
      let sx = 0;
      let sz = 0;
      for (let k = -5; k <= 5; k += 1) {
        const [x, z] = line[(i + k + m) % m] as [number, number];
        sx += x;
        sz += z;
      }
      return [sx / 11, sz / 11] as [number, number];
    });
  }
  // From the sample nearest a point a little past `from`, the way that heads north.
  const nearest = (x: number, z: number) =>
    line.reduce(
      (b, p, i) =>
        Math.hypot(p[0] - x, p[1] - z) < Math.hypot(line[b]![0] - x, line[b]![1] - z) ? i : b,
      0,
    );
  const a = nearest(from[0], from[1] - 140);
  const b = nearest(to[0], to[1] - 60);
  const step = line[(a + 1) % m]![1] < line[a]![1] ? 1 : -1;
  const out: [number, number][] = [from, [from[0], from[1] - 16]];
  for (let i = a; i !== b; i = (i + step + m) % m) out.push(line[i] as [number, number]);
  out.push(line[b] as [number, number], [to[0], to[1] - 16], to);
  return out;
}

const only = process.argv[2];
const specs: HillRoadSpec[] = [];
for (const route of ROUTES) {
  if (only && route.name !== only) continue;
  if (route.coast) {
    const smooth = chaikin(coastRoute(route.from, route.to, route.coast), 3);
    const path = thin(smooth, 0.6).map(
      ([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as [number, number],
    );
    specs.push({ name: route.name, path });
    continue;
  }
  const quarry = inside(QUARRY, ...route.to);
  const built = () => makeHillRoads(naturalHeight, specs);
  /** The point of an earlier road nearest (x, z). */
  const onRoad = (name: string, x: number, z: number): [number, number] => {
    const road = built().find((r) => r.name === name);
    if (!road) throw new Error(`${route.name}: no ${name}`);
    let best = road.points[0]!;
    for (const p of road.points)
      if (Math.hypot(p.x - x, p.z - z) < Math.hypot(best.x - x, best.z - z)) best = p;
    return [best.x, best.z];
  };
  const toward = (a: [number, number], b: [number, number]) => {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let best = 0;
    DIRS.forEach(([i, j], d) => {
      const off = (q: number) => Math.abs(Math.atan2(Math.sin(q - ang), Math.cos(q - ang)));
      if (off(Math.atan2(j, i)) < off(Math.atan2(DIRS[best]![1], DIRS[best]![0]))) best = d;
    });
    return best;
  };
  // Out of a street's end straight north for 16 m; or from the road it leaves.
  const start: [number, number] = route.leaves ? onRoad(route.leaves, ...route.from) : route.from;
  const atStreet = (p: [number, number]) => p[1] === EDGE_Z;
  let grid: [number, number][] = atStreet(start) ? [[start[0], start[1] - 16]] : [start];
  let dir = atStreet(start) ? 0 : toward(start, route.to);
  // A road that joins another heads for the nearest point of it.
  const end: [number, number] = atStreet(route.to)
    ? [route.to[0], route.to[1] - 16]
    : route.joins
      ? onRoad(route.joins, ...route.to)
      : route.to;
  for (const target of [...(route.via ?? []), end]) {
    const leg = search(grid[grid.length - 1] as [number, number], dir, target, quarry);
    const [p, q] = leg.slice(-2) as [[number, number], [number, number]];
    const di = Math.round((q[0] - p[0]) / G);
    const dj = Math.round((q[1] - p[1]) / G);
    dir = Math.max(
      0,
      DIRS.findIndex(([a, b]) => a === di && b === dj),
    );
    grid = [...grid, ...leg.slice(1)];
  }
  // The search stops near its target: drop the last few points, so the way in is a curve and
  // not a kink. Then into a street's end straight from the stub south of it, or exactly onto
  // the road it joins.
  while (
    grid.length > 2 &&
    Math.hypot(grid[grid.length - 1]![0] - end[0], grid[grid.length - 1]![1] - end[1]) < 24
  )
    grid.pop();
  if (atStreet(route.to)) grid.push(end, route.to);
  else grid.push(end);
  if (atStreet(start)) grid.unshift(start);
  const smooth = chaikin(grid, 4);
  const path = thin(smooth, 0.6).map(
    ([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as [number, number],
  );
  specs.push({
    name: route.name,
    path,
    ...(route.leaves ? { leaves: route.leaves } : {}),
    ...(route.joins ? { joins: route.joins } : {}),
  });
  markRoad(smooth);
}

// Report each road's profile: length, grade, cut and fill.
const roads = makeHillRoads(naturalHeight, specs);
for (const r of roads) {
  let len = 0;
  let grade = 0;
  let cut = 0;
  let fill = 0;
  for (let i = 1; i < r.points.length; i += 1) {
    const a = r.points[i - 1]!;
    const b = r.points[i]!;
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    len += d;
    grade = Math.max(grade, Math.abs(b.y - a.y) / d);
    const g = naturalHeight(b.x, b.z);
    cut = Math.max(cut, g - b.y);
    fill = Math.max(fill, b.y - g);
  }
  const top = Math.max(...r.points.map((p) => p.y));
  console.error(
    `${r.name}: ${Math.round(len)} m, top ${top.toFixed(0)} m, grade ${(grade * 100).toFixed(1)}% (limit ${HILL_GRADE * 100}%), cut ${cut.toFixed(1)} m, fill ${fill.toFixed(1)} m`,
  );
}
console.log(
  specs
    .map(
      (s) =>
        `  {\n    name: '${s.name}',\n${s.leaves ? `    leaves: '${s.leaves}',\n` : ''}${s.joins ? `    joins: '${s.joins}',\n` : ''}    path: [\n${s.path.map(([x, z]) => `      [${x}, ${z}],`).join('\n')}\n    ],\n  },`,
    )
    .join('\n'),
);
