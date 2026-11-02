/**
 * Terrain (Phase 2): one height function shared by the server (height checks) and the client
 * (the ground mesh and the physics heightfields), sampled on a 4 m grid.
 *
 * - The developed city is flat (y = 0), so streets, blocks and buildings are unchanged.
 * - North of the city foothills climb gently, cut by canyons, to a steep range whose peaks are
 *   too steep to climb or drive up; it falls to a narrow beach all along the island's shore
 *   (cliffs where the peaks are near the sea). The observatory's terrace is cut into the foot
 *   of the range; the quarry is a pit cut into it. The sea all round the island keeps
 *   everyone in the world.
 * - The hill roads (hillroads.ts) are graded into the foothills: `terrainHeight` is the
 *   natural ground cut and filled to them.
 * - The river is a concrete flood channel, 6 m deep with sloping banks you can drive down, and
 *   a ramp up to street level at its north end.
 */
import { coastDistance, inside, isLand, LAKE, lakeEdgeDistance, QUARRY, RIVER } from './plan.ts';
import type { Rect } from './layout.ts';
import { Grading, HILL_HALF, type HillRoad, makeHillRoads } from './hillroads.ts';
import { hash2 } from './random.ts';
import { type HillVilla, placeVillas, villaPad } from './villas.ts';

/** Sample spacing of the terrain grid (m): the physics heightfields and the near ground mesh. */
export const TERRAIN_STEP = 4;
/** The river channel's depth and the width of each sloping bank (m). */
export const RIVER_DEPTH = 6;
export const RIVER_BANK = 16;
/** Length of the ramp from the channel floor up to street level at its north end (m). */
export const RIVER_RAMP = 80;
/** Where the channel's floor is level (between the banks). */
export const RIVER_FLOOR = { x0: RIVER.x0 + RIVER_BANK, x1: RIVER.x1 - RIVER_BANK };
/** The sea floor, for terrain samples off the coast (drawn as cliffs falling into the water). */
export const SEA_FLOOR = -4;

/** The edge of the developed city the hills start from. */
const HILLS_FROM_Z = -840;
/** Foothills: the grade they climb at (after easing in from the city), the canyons' relief (m). */
const FOOT_GRADE = 0.2;
const FOOT_EASE = 40;
const FOOT_RELIEF = 70;
/** Size of the canyons and ridges (long north–south, as they run down to the city). */
const FOOT_GRAIN = { x: 210, z: 420 };
/**
 * The range behind the foothills: where its front starts (m north of the city), how far it
 * wavers, its height and the distance it rises over.
 */
const RANGE_FROM = 330;
const RANGE_WAVER = 120;
const RANGE_HEIGHT = 240;
const RANGE_RISE = 220;
/** The flat beach along the shore, and the distance the slopes take to rise from it (m). */
const BEACH = 40;
const SHORE_RISE = 200;

/** Regions where the ground isn't flat (each gets its own heightfield and ground tiles). */
export const TERRAIN_REGIONS: readonly Rect[] = [
  { x0: -1536, z0: -1536, x1: 1536, z1: HILLS_FROM_Z },
  { x0: RIVER.x0 - 4, z0: RIVER.z0 - 4, x1: RIVER.x1 + 4, z1: RIVER.z1 + 4 },
];

/** Seed for the villas' sizes and gaps (fixed: the server and every client agree). */
const VILLA_SEED = 0x51115;

/** The lake's level rim round the water, the width its banks blend over, its depth (m). */
const LAKE_RIM = 6;
const LAKE_BLEND = 30;
const LAKE_DEPTH = 6;

/** The observatory's terrace in the hills. */
export const OBSERVATORY_AT = { x: -160, z: -1200 };
const PLATEAU_FLAT = 70;
const PLATEAU_BLEND = 130;

const smooth = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Smooth value noise in [0, 1). */
function noise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const at = (i: number, j: number) => hash2(hash2(seed, xi + i), zi + j) / 4294967296;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = at(0, 0) + (at(1, 0) - at(0, 0)) * u;
  const b = at(0, 1) + (at(1, 1) - at(0, 1)) * u;
  return a + (b - a) * v;
}

/** Fractal noise in about [0, 1): broad shapes plus finer ridges. */
function fbm(x: number, z: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o += 1) {
    sum += amp * noise(x * freq, z * freq, 0x5011 + o);
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / 0.9375;
}

/** The hills and mountains north of the city, before levelling. */
function hills(x: number, z: number): number {
  if (z >= HILLS_FROM_Z) return 0;
  const u = HILLS_FROM_Z - z;
  // Foothills rising gently from the city, cut by canyons and ridges that run down towards it
  // (where the hill roads wind up and the villas sit).
  const grain = noise(x / FOOT_GRAIN.x, z / FOOT_GRAIN.z, 0xca9) + 0.3 * fbm(x / 90, z / 90);
  const climb = FOOT_GRADE * (u - FOOT_EASE * (1 - Math.exp(-u / FOOT_EASE)));
  // Canyon floors stay above the city's level (the ground mesh leaves flat cells to the city).
  const foot = Math.max(climb * 0.35, climb + FOOT_RELIEF * smooth(30, 260, u) * (grain - 0.65));
  // The range behind them: its front wavers (spurs reaching south, bays between), with peaks
  // along the top; it falls to the beach wherever the shore is near.
  const front = RANGE_FROM + RANGE_WAVER * (fbm(x / 420, 7.3) - 0.5);
  const ridges = 0.6 + 0.8 * fbm(x / 260, z / 260);
  const range = RANGE_HEIGHT * smooth(front, front + RANGE_RISE, u) * ridges;
  return Math.max(0, foot + range) * smooth(BEACH, BEACH + SHORE_RISE, coastDistance(x, z));
}

let hillRoadsBuilt: HillRoad[] | null = null;
let villasBuilt: HillVilla[] | null = null;
let grading: Grading | null = null;

/** The hill roads, built over the natural ground on first use. */
export function hillRoads(): HillRoad[] {
  hillRoadsBuilt ??= makeHillRoads(naturalHeight);
  return hillRoadsBuilt;
}

/** The villas along the hill roads (villas.ts), placed on first use. */
export function hillVillas(): HillVilla[] {
  villasBuilt ??= placeVillas(
    hillRoads(),
    naturalHeight,
    // Clear of the city's edge and the observatory's terrace.
    (x, z) =>
      z > HILLS_FROM_Z - 40 ||
      Math.hypot(x - OBSERVATORY_AT.x, z - OBSERVATORY_AT.z) < PLATEAU_BLEND + 20,
    VILLA_SEED,
  );
  return villasBuilt;
}

/** Ground height at (x, z) (m): the natural ground, cut and filled to the hill roads and pads. */
export function terrainHeight(x: number, z: number): number {
  const h = naturalHeight(x, z);
  if (z >= HILLS_FROM_Z) return h;
  grading ??= new Grading(hillRoads(), hillVillas().map(villaPad));
  return grading.apply(x, z, h);
}

/** The ground before the hill roads are graded into it (m). */
export function naturalHeight(x: number, z: number): number {
  if (!isLand(x, z)) return SEA_FLOOR;
  if (inside(RIVER, x, z)) {
    const bank = Math.min(x - RIVER.x0, RIVER.x1 - x) / RIVER_BANK;
    // Full depth beyond the ramp at the north end.
    const ramp = Math.min(1, Math.max(0, (z - RIVER.z0) / RIVER_RAMP));
    return -RIVER_DEPTH * Math.min(1, Math.max(0, bank)) * ramp;
  }
  let h = hills(x, z);
  if (h <= 0) return 0;
  // The quarry: a level pit floor, its walls rising over 60 m.
  const qx = Math.max(QUARRY.x0 - x, 0, x - QUARRY.x1);
  const qz = Math.max(QUARRY.z0 - z, 0, z - QUARRY.z1);
  h *= smooth(0, 60, Math.hypot(qx, qz));
  // The lake: its bed sunk below the water, a level rim round it (cut down into the hillside
  // to the north, raised as an earth dam across the canyon to the south), blending back.
  const edge = lakeEdgeDistance(x, z);
  if (edge < LAKE_RIM + LAKE_BLEND) {
    const rim = LAKE.level + 1.5;
    if (edge > LAKE_RIM) h += (rim - h) * (1 - smooth(LAKE_RIM, LAKE_RIM + LAKE_BLEND, edge));
    else if (edge >= 0) h = rim;
    else {
      const bed = rim - 1.9 * smooth(0, 4, -edge) - LAKE_DEPTH * smooth(4, 34, -edge);
      h = Math.min(h, bed);
    }
  }
  // The observatory's terrace, cut into the foot of the range level with the ground in front
  // of the building (the road arrives up the slope below it, not up the sides of a mound).
  const d = Math.hypot(x - OBSERVATORY_AT.x, z - OBSERVATORY_AT.z);
  if (d < PLATEAU_BLEND) {
    const level = hills(OBSERVATORY_AT.x, OBSERVATORY_AT.z + PLATEAU_FLAT / 2);
    h += (level - h) * (1 - smooth(PLATEAU_FLAT, PLATEAU_BLEND, d));
  }
  return h;
}

/** Cells (m) of the index of where the hill roads and villa pads are. */
const PAVED_CELL = 16;
let paved: Set<number> | null = null;
const pavedKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

/**
 * Off the roads in the hills (owner, 2026-10-29: players use the hill roads, they don't drive
 * up the mountain): north of the city's edge, on raised ground, and more than a lane's width
 * from any hill road or villa pad. Cars slow to a crawl there and can't climb (driving.ts);
 * scrub and boulders grow there (client hillscrub.ts).
 */
export function offRoadInHills(x: number, z: number, margin = 3): boolean {
  if (z >= HILLS_FROM_Z || terrainHeight(x, z) < 1.5) return false;
  if (!paved) {
    const cells = new Set<number>();
    paved = cells;
    const mark = (px: number, pz: number, r: number) => {
      for (
        let cx = Math.floor((px - r) / PAVED_CELL);
        cx <= Math.floor((px + r) / PAVED_CELL);
        cx += 1
      )
        for (
          let cz = Math.floor((pz - r) / PAVED_CELL);
          cz <= Math.floor((pz + r) / PAVED_CELL);
          cz += 1
        )
          cells.add(pavedKey(cx, cz));
    };
    for (const road of hillRoads()) for (const p of road.points) mark(p.x, p.z, HILL_HALF + 8);
    for (const v of hillVillas()) mark(v.x, v.z, Math.max(v.w, v.d) / 2 + 12);
  }
  if (!paved.has(pavedKey(Math.floor(x / PAVED_CELL), Math.floor(z / PAVED_CELL)))) return true;
  // Near a road's cell: the exact distance to its centreline.
  for (const road of hillRoads()) {
    for (const p of road.points) {
      if (
        Math.abs(p.x - x) < HILL_HALF + margin + 4 &&
        Math.abs(p.z - z) < HILL_HALF + margin + 4
      ) {
        if (Math.hypot(p.x - x, p.z - z) < HILL_HALF + margin) return false;
      }
    }
  }
  for (const v of hillVillas()) {
    if (Math.abs(v.x - x) < v.w / 2 + margin + 6 && Math.abs(v.z - z) < v.d / 2 + margin + 6)
      return false;
    if (Math.abs(v.x - x) < 4 && (z - v.z) * (z - v.toZ) <= 0) return false;
  }
  return true;
}
