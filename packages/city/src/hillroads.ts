/**
 * Hill roads (Phase 2, owner's reference 2026-10-29: roads winding up through green hills,
 * villas on the slopes): two-lane roads from the ends of the city's streets up through the
 * foothills, switching back where the slope is steep, to the observatory, along the hills to
 * above the lake, and into the quarry.
 *
 * Routes are found offline (scripts/city/route-hills.ts: least-cost paths that hold a road's
 * grade, follow the contours and turn gently) and kept here as control points. Heights are
 * worked out at load: the ground along the route, smoothed, held under the grade limit and
 * pinned where a road starts at a street or joins another. The terrain is then cut and filled
 * to them (`Grading`, used by terrain.ts), so the server, physics and drawing stand on the
 * same road.
 */
import type { RampPoint } from './ramps.ts';
import type { Pad } from './villas.ts';

export interface HillRoadSpec {
  name: string;
  /** Control points (x, z) from the router, from the start to the end. */
  path: readonly (readonly [number, number])[];
  /** The hill road its start leaves from, and the one its end joins (taking their heights). */
  leaves?: string;
  joins?: string;
}

export interface HillRoad {
  name: string;
  /** The centreline every few metres, with the road's height. */
  points: RampPoint[];
  /** The hill roads its start leaves from and its end joins. */
  leaves?: string;
  joins?: string;
}

/** Half the carriageway: a 3.5 m lane each way and a 0.5 m shoulder. */
export const HILL_HALF = 4;
/** Steepest grade a hill road climbs at. */
export const HILL_GRADE = 0.11;
/** Spacing of the centreline's points (m). */
const STEP = 4;
/** Ground kept level with the road beyond its edges, and the width the cut or fill then takes
 * to blend back into the hillside (m). */
const SHOULDER = 2.5;
const BLEND = 32;
/** Window the ground along a route is averaged over before the grade limit (m either side). */
const SMOOTH = 24;
/** Cell size of the grading's index of road segments (m). */
const CELL = 32;

/**
 * The routes (scripts/city/route-hills.ts prints these): Observatory Road up from Sol
 * Boulevard to the observatory; Crest Drive up from Vista Street along the west hills to it,
 * Mirador Drive up from Sierra Street to Crest Drive; Sycamore Drive along the hills from
 * Observatory Road's second hairpin to above the lake, Lago Drive up from Camino Real to it;
 * Quarry Road from Dock Street into the quarry; the Coast Road from Ocean Avenue up the
 * Pacific side, along the north shore under the cliffs and down the east shore to Orchard
 * Avenue, just behind the beach.
 */
export const HILL_ROAD_SPECS: readonly HillRoadSpec[] = [
  {
    name: 'Observatory Road',
    path: [
      [0, -840],
      [-0.2, -851.5],
      [-2.4, -860.5],
      [-8.7, -872.1],
      [-15.2, -878.7],
      [-23.5, -883.7],
      [-137.5, -940.7],
      [-147.7, -947.7],
      [-168.2, -968.4],
      [-172.4, -975.8],
      [-173.1, -982.5],
      [-171.8, -989.1],
      [-168.3, -995.4],
      [-163.1, -1000.5],
      [-155.7, -1004.2],
      [-147.8, -1005.1],
      [-141.6, -1003.6],
      [-126.5, -995.3],
      [-117.3, -992.1],
      [-58.7, -992.1],
      [-49.5, -995.3],
      [-14.5, -1012.7],
      [-7.9, -1016.7],
      [2.2, -1024.7],
      [13, -1030.3],
      [19.8, -1032],
      [44.3, -1032],
      [50.2, -1030.6],
      [65.4, -1024.3],
      [84.8, -1024],
      [89.4, -1022.9],
      [116.2, -1010.1],
      [131, -1006.3],
      [160.1, -992.7],
      [175.2, -991.5],
      [194.1, -984.2],
      [212.3, -984],
      [217.4, -985.1],
      [225.5, -988.7],
      [234, -993.3],
      [238.7, -997.3],
      [241.7, -1002.1],
      [243.3, -1007.3],
      [243.2, -1012.3],
      [241.5, -1017.3],
      [236.5, -1022.9],
      [229.3, -1025.9],
      [223.3, -1026],
      [212.7, -1024],
      [203.2, -1024],
      [198.6, -1025.1],
      [155.8, -1046.2],
      [148.8, -1051.2],
      [130.8, -1069.3],
      [119.3, -1088.1],
      [112.8, -1094.7],
      [104.5, -1099.7],
      [53.6, -1125.2],
      [37.8, -1136.7],
      [24.6, -1143.1],
      [20.3, -1144],
      [-21.3, -1144.1],
      [-39.4, -1151.1],
      [-45.9, -1151.8],
      [-54.5, -1148.7],
      [-125, -1113.7],
      [-131.2, -1112],
      [-148.2, -1112],
      [-157.9, -1113.1],
      [-164.6, -1117],
      [-164.4, -1124.5],
      [-160, -1144],
    ],
  },
  {
    name: 'Crest Drive',
    joins: 'Observatory Road',
    path: [
      [-960, -840],
      [-959.8, -851.5],
      [-957.6, -860.5],
      [-951.2, -872.1],
      [-944.8, -878.7],
      [-936.5, -883.7],
      [-835.8, -933.9],
      [-828.8, -936],
      [-803.7, -936],
      [-799.4, -936.9],
      [-756.7, -957.6],
      [-741, -961.7],
      [-717.6, -973.2],
      [-710.6, -975.7],
      [-651.2, -976],
      [-630.6, -983.7],
      [-608.1, -984.7],
      [-593.4, -990.9],
      [-579.3, -994.4],
      [-526.5, -1020.7],
      [-516.8, -1027.2],
      [-510.2, -1035.8],
      [-505.1, -1046.6],
      [-503.5, -1055.2],
      [-501.2, -1061.6],
      [-490.7, -1082.4],
      [-485.2, -1090.7],
      [-475.3, -1098.2],
      [-449.4, -1110.9],
      [-444.8, -1112],
      [-434.1, -1111.8],
      [-417.4, -1105.1],
      [-411.7, -1104],
      [-406.6, -1105.1],
      [-389.9, -1111.8],
      [-369.4, -1112.3],
      [-356.7, -1117.7],
      [-341.8, -1128.7],
      [-330.2, -1134.6],
      [-324.8, -1136],
      [-305.4, -1136.3],
      [-290.2, -1142.6],
      [-284.2, -1144],
      [-274.7, -1143.9],
      [-268.2, -1141.9],
      [-198.5, -1107.3],
      [-189.9, -1104.2],
      [-186.6, -1104.2],
      [-182.2, -1106.3],
      [-165, -1120.3],
    ],
  },
  {
    name: 'Mirador Drive',
    joins: 'Crest Drive',
    path: [
      [-480, -840],
      [-479.9, -850.5],
      [-478.3, -858.5],
      [-473.7, -868.2],
      [-468.2, -875.7],
      [-457.5, -883.2],
      [-380.4, -922.5],
      [-375.3, -928.1],
      [-372.8, -935],
      [-373.2, -942],
      [-376.4, -948.1],
      [-381.3, -952],
      [-387.3, -954],
      [-393, -954],
      [-401.9, -952.1],
      [-407.9, -952.7],
      [-435.3, -965.6],
      [-443.2, -968],
      [-580.8, -968.1],
      [-588.9, -972.6],
      [-604.2, -986],
    ],
  },
  {
    name: 'Sycamore Drive',
    leaves: 'Observatory Road',
    path: [
      [239.3, -1020.3],
      [254.4, -1030.6],
      [267.3, -1037.6],
      [274.1, -1039.8],
      [285.3, -1040.1],
      [291, -1041.7],
      [345.5, -1068.7],
      [355.8, -1072],
      [453.9, -1071.8],
      [461.6, -1069.2],
      [484.2, -1058.1],
      [498.2, -1054.6],
      [523.3, -1042.4],
      [531.2, -1040],
      [653.3, -1040.1],
      [666.4, -1045.2],
      [676.8, -1052.9],
      [682.3, -1064.5],
      [690, -1090],
    ],
  },
  {
    name: 'Lago Drive',
    joins: 'Sycamore Drive',
    path: [
      [480, -840],
      [480.5, -853.5],
      [483.8, -863.5],
      [490.8, -874.7],
      [499.8, -881.7],
      [555.3, -909.6],
      [569.4, -913.1],
      [584.1, -919.3],
      [628.8, -920],
      [637.6, -922.8],
      [695.4, -952.2],
      [725.9, -981.7],
      [746.3, -993.5],
      [752.4, -999.6],
      [754.5, -1004.1],
      [755.4, -1008.8],
      [755, -1013.5],
      [753.1, -1018],
      [750.1, -1021.6],
      [746.2, -1024.3],
      [741.6, -1025.8],
      [736.3, -1026.1],
      [729.6, -1024.5],
      [715.3, -1013.7],
      [675.8, -994.1],
      [668.8, -992],
      [656.8, -992.5],
      [631.5, -1004.2],
      [626.5, -1008],
      [618.6, -1018.5],
      [608.4, -1037.8],
    ],
  },
  {
    name: 'Quarry Road',
    path: [
      [1080, -840],
      [1080.1, -850.5],
      [1081.1, -856.5],
      [1087.8, -870.6],
      [1091.8, -875.7],
      [1095.9, -879.2],
      [1110.6, -886.9],
      [1115.8, -888],
      [1285.9, -888.2],
      [1295.5, -891.7],
      [1335.4, -912.2],
      [1349.3, -925.3],
      [1355.8, -935.5],
      [1359.8, -946.1],
      [1358.9, -953.4],
      [1350.8, -968.8],
      [1346.7, -973.2],
      [1341, -977.2],
      [1222.4, -1036.7],
      [1207.3, -1039.7],
      [1180, -1040],
    ],
  },
  {
    name: 'Coast Road',
    path: [
      [-1200, -840],
      [-1200, -849],
      [-1203.4, -865.4],
      [-1236.1, -986.4],
      [-1232.7, -1042],
      [-1227.7, -1094.3],
      [-1203.7, -1278.3],
      [-1199, -1307.6],
      [-1194.5, -1326.9],
      [-1189.2, -1342],
      [-1182.2, -1353.8],
      [-1173, -1363.5],
      [-1160.3, -1372.2],
      [-1143.4, -1380.1],
      [-1121.2, -1388],
      [-1086.1, -1397.8],
      [-1044.7, -1407.3],
      [-1003.8, -1415],
      [-960.8, -1421.3],
      [-885.5, -1430.2],
      [-798.9, -1438.9],
      [-744.1, -1443],
      [-684.5, -1445.8],
      [-494.2, -1451.3],
      [-404, -1452.9],
      [38.9, -1448.6],
      [364.7, -1451.7],
      [753.4, -1456.8],
      [843.6, -1455.1],
      [979, -1448.4],
      [1042, -1443.9],
      [1086.4, -1437.9],
      [1113.3, -1432.1],
      [1142.7, -1424],
      [1177.4, -1412.7],
      [1209.2, -1400.8],
      [1230.1, -1391.7],
      [1247.7, -1382.4],
      [1262.6, -1372.7],
      [1276.9, -1361.1],
      [1292.1, -1346],
      [1308.3, -1327.1],
      [1325.2, -1304.7],
      [1339.9, -1282.8],
      [1350.4, -1264.7],
      [1359.5, -1245.9],
      [1367.9, -1225.4],
      [1375.8, -1202],
      [1397.3, -1123.3],
      [1412, -1055.4],
      [1420.5, -995],
      [1429.2, -902.1],
      [1439, -857.5],
      [1440, -840],
    ],
  },
];

/** Densifies control points with a centripetal Catmull–Rom curve, about `STEP` m apart. */
function curve(path: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  const p = (i: number) => path[Math.min(path.length - 1, Math.max(0, i))] as [number, number];
  for (let i = 0; i < path.length - 1; i += 1) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const knot = (a: [number, number], b: [number, number]) =>
      Math.max(1e-3, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / STEP));
    for (let k = 0; k < n; k += 1) {
      const t = t1 + ((t2 - t1) * k) / n;
      const lerp = (a: [number, number], b: [number, number], ta: number, tb: number) => {
        const w = tb === ta ? 0 : (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w] as [number, number];
      };
      const a1 = lerp(p0, p1, 0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  out.push(p(path.length - 1));
  return out;
}

/** Distances along a polyline. */
function chainage(xz: readonly { x: number; z: number }[]): number[] {
  const s = [0];
  for (let i = 1; i < xz.length; i += 1) {
    const a = xz[i - 1] as { x: number; z: number };
    const b = xz[i] as { x: number; z: number };
    s.push((s[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return s;
}

/**
 * Heights along a route: the ground averaged over `SMOOTH` m, pinned at `pins` (index →
 * height), then held to the grade limit both ways (a pin wins over the ground).
 */
function profile(
  xz: { x: number; z: number }[],
  ground: (x: number, z: number) => number,
  pins: Map<number, number>,
): number[] {
  const s = chainage(xz);
  const raw = xz.map((p) => ground(p.x, p.z));
  let y = raw.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && (s[i] as number) - (s[j] as number) <= SMOOTH; j -= 1) {
      sum += raw[j] as number;
      n += 1;
    }
    for (let j = i + 1; j < raw.length && (s[j] as number) - (s[i] as number) <= SMOOTH; j += 1) {
      sum += raw[j] as number;
      n += 1;
    }
    return sum / n;
  });
  // Pins hold the heights within reach of the grade limit either side of them.
  for (const [at, h] of pins) {
    y = y.map((v, i) => {
      const reach = HILL_GRADE * Math.abs((s[i] as number) - (s[at] as number));
      return Math.min(h + reach, Math.max(h - reach, v));
    });
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 1; i < y.length; i += 1) {
      const lim = HILL_GRADE * ((s[i] as number) - (s[i - 1] as number));
      y[i] = Math.min(
        (y[i - 1] as number) + lim,
        Math.max((y[i - 1] as number) - lim, y[i] as number),
      );
    }
    for (let i = y.length - 2; i >= 0; i -= 1) {
      const lim = HILL_GRADE * ((s[i + 1] as number) - (s[i] as number));
      y[i] = Math.min(
        (y[i + 1] as number) + lim,
        Math.max((y[i + 1] as number) - lim, y[i] as number),
      );
    }
  }
  return y;
}

/** Nearest point of segment ab to (x, z): its distance and the parameter along ab. */
function nearest(ax: number, az: number, bx: number, bz: number, x: number, z: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2));
  return { d: Math.hypot(x - ax - dx * t, z - az - dz * t), t };
}

/** Builds the hill roads over the natural ground, in order (a road joins one built before). */
export function makeHillRoads(
  ground: (x: number, z: number) => number,
  specs: readonly HillRoadSpec[] = HILL_ROAD_SPECS,
): HillRoad[] {
  const roads: HillRoad[] = [];
  for (const spec of specs) {
    const xz = curve(spec.path).map(([x, z]) => ({ x, z }));
    const pins = new Map<number, number>();
    for (const [at, other] of [
      [0, spec.leaves],
      [xz.length - 1, spec.joins],
    ] as const) {
      const p = xz[at] as { x: number; z: number };
      if (other) {
        const road = roads.find((r) => r.name === other);
        if (!road) throw new Error(`${spec.name} meets ${other}, not built before it`);
        // Where the two roads' level ground overlaps at the junction, this one lies on the
        // other's surface (no step between them).
        xz.forEach((q, i) => {
          const near = distanceToRoad(road, q.x, q.z);
          if (near.d < 2 * (HILL_HALF + SHOULDER)) pins.set(i, near.y);
        });
      } else if (Math.abs(ground(p.x, p.z)) < 0.01) {
        // Level with the street it carries on from.
        pins.set(at, 0);
      }
    }
    const y = profile(xz, ground, pins);
    roads.push({
      name: spec.name,
      points: xz.map((p, i) => ({ x: p.x, y: y[i] as number, z: p.z })),
      ...(spec.leaves ? { leaves: spec.leaves } : {}),
      ...(spec.joins ? { joins: spec.joins } : {}),
    });
  }
  return roads;
}

/** A guard rail along a hill road's edge: its line, at the road's height. */
export interface GuardRail {
  points: RampPoint[];
}

/** Where the rail stands from the centreline, how far out the drop is measured, and how deep. */
const RAIL_AT = HILL_HALF + 0.9;
const DROP_AT = HILL_HALF + SHOULDER + 8;
const DROP = 2.5;
/** Shortest rail worth building, and how far it keeps from junctions and street ends (m). */
const RAIL_MIN = 16;
const RAIL_CLEAR = 20;

/**
 * Guard rails on the side of a hill road where the ground falls away (on fill, or along a
 * hillside): wherever it is `DROP` m below the road a little way out from the shoulder.
 */
export function guardRails(
  roads: readonly HillRoad[],
  height: (x: number, z: number) => number,
): GuardRail[] {
  const rails: GuardRail[] = [];
  for (const road of roads) {
    const pts = road.points;
    const s = chainage(pts);
    const total = s[s.length - 1] as number;
    const reach = (2 * RAIL_AT + RAIL_CLEAR + STEP) ** 2;
    const nearOther = pts.map((p) =>
      roads.some(
        (r) => r !== road && r.points.some((q) => (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < reach),
      ),
    );
    for (const side of [-1, 1]) {
      let run: RampPoint[] = [];
      const flush = () => {
        if (run.length > 1 && chainage(run)[run.length - 1]! >= RAIL_MIN)
          rails.push({ points: run });
        run = [];
      };
      pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)] as RampPoint;
        const b = pts[Math.min(pts.length - 1, i + 1)] as RampPoint;
        const n = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const [nx, nz] = [(-(b.z - a.z) / n) * side, ((b.x - a.x) / n) * side];
        const nearEnd = (s[i] as number) < RAIL_CLEAR || total - (s[i] as number) < RAIL_CLEAR;
        const drop = p.y - height(p.x + nx * DROP_AT, p.z + nz * DROP_AT);
        if (nearEnd || nearOther[i] || drop < DROP) return flush();
        run.push({ x: p.x + nx * RAIL_AT, y: p.y, z: p.z + nz * RAIL_AT });
      });
      flush();
    }
  }
  return rails;
}

/** Distance from (x, z) to the road's centreline, and the road's height at its nearest point. */
function distanceToRoad(road: HillRoad, x: number, z: number): { d: number; y: number } {
  let d = Infinity;
  let y = 0;
  const pts = road.points;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1] as RampPoint;
    const b = pts[i] as RampPoint;
    const n = nearest(a.x, a.z, b.x, b.z, x, z);
    if (n.d < d) {
      d = n.d;
      y = a.y + (b.y - a.y) * n.t;
    }
  }
  return { d, y };
}

/** A level surface the ground is cut and filled to: a stretch of road, or a pad (a = b). */
interface Piece {
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  /** Ground level with it this far from its line (m). */
  flat: number;
  /** Its weight per metre of distance falloff: its length (a pad: its size). */
  weight: number;
  /** Which road (or pad) it belongs to. */
  owner: number;
}

/**
 * The ground cut and filled to the hill roads (and the villas' pads). Level with the road out to `SHOULDER` past its
 * edges, then blending back to the hillside over `BLEND` m: every stretch of road nearby pulls
 * the ground towards its own height, weighted by its length and by a falloff that grows
 * without bound at the shoulder (so the ground meets the road exactly, and the bank starts
 * level and rounds over like an embankment's) and fades to nothing `BLEND` m out. Summed over the road like an integral, the bank between two legs of a
 * switchback is a smooth slope with no steps.
 */
export class Grading {
  private readonly cells = new Map<number, Piece[]>();

  constructor(roads: readonly HillRoad[], pads: readonly Pad[] = []) {
    // Pads (villas.ts) after the roads, each its own owner.
    pads.forEach((p, i) =>
      this.add({
        ax: p.ax,
        az: p.az,
        ay: p.y,
        bx: p.bx,
        bz: p.bz,
        by: p.y,
        flat: p.flat,
        weight: Math.max(8, Math.hypot(p.bx - p.ax, p.bz - p.az) + p.flat),
        owner: roads.length + i,
      }),
    );
    roads.forEach((road, owner) => {
      for (let i = 1; i < road.points.length; i += 1) {
        const a = road.points[i - 1] as RampPoint;
        const b = road.points[i] as RampPoint;
        this.add({
          ax: a.x,
          az: a.z,
          ay: a.y,
          bx: b.x,
          bz: b.z,
          by: b.y,
          flat: HILL_HALF + SHOULDER,
          weight: Math.hypot(b.x - a.x, b.z - a.z),
          owner,
        });
      }
    });
  }

  private add(p: Piece) {
    const reach = p.flat + BLEND;
    for (
      let cx = cell(Math.min(p.ax, p.bx) - reach);
      cx <= cell(Math.max(p.ax, p.bx) + reach);
      cx += 1
    ) {
      for (
        let cz = cell(Math.min(p.az, p.bz) - reach);
        cz <= cell(Math.max(p.az, p.bz) + reach);
        cz += 1
      ) {
        const k = cx * 4096 + cz;
        const list = this.cells.get(k);
        if (list) list.push(p);
        else this.cells.set(k, [p]);
      }
    }
  }

  /**
   * The graded height at (x, z) over the natural `ground` height there. On a road's level
   * ground: the road's height at its nearest point (no curve is tighter than that ground is
   * wide). Where two roads' level ground overlaps (a junction), each one's height weighted by
   * how far inside its level ground the point is (squared: it rounds off), so the hand-over
   * has no step.
   */
  apply(x: number, z: number, ground: number): number {
    const list = this.cells.get(cell(x) * 4096 + cell(z));
    if (!list) return ground;
    const flats = this.flats;
    flats.length = 0;
    let num = ground * BLEND;
    let den = BLEND;
    for (const p of list) {
      const { d, t } = nearest(p.ax, p.az, p.bx, p.bz, x, z);
      if (d >= p.flat + BLEND) continue;
      const y = p.ay + (p.by - p.ay) * t;
      if (d <= p.flat) {
        const mine = flats.find((f) => f.owner === p.owner);
        if (!mine) flats.push({ owner: p.owner, d, depth: p.flat - d, y });
        else if (d < mine.d) Object.assign(mine, { d, depth: p.flat - d, y });
        continue;
      }
      const u = (d - p.flat) / BLEND;
      const k = p.weight * ((1 - u) / u) ** 1.5;
      num += k * y;
      den += k;
    }
    if (flats.length === 1) return (flats[0] as Flat).y;
    if (flats.length > 1) {
      let sum = 0;
      let w = 0;
      for (const f of flats) {
        sum += f.depth * f.depth * f.y;
        w += f.depth * f.depth;
      }
      return w > 0 ? sum / w : (flats[0] as Flat).y;
    }
    return num / den;
  }

  private readonly flats: Flat[] = [];
}

/** A road whose level ground a point is on: how near its line, how far inside, its height. */
interface Flat {
  owner: number;
  d: number;
  depth: number;
  y: number;
}

function cell(v: number): number {
  return Math.floor(v / CELL);
}
