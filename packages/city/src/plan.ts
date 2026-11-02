/**
 * The Los Soles city plan (docs/city-plan.md, approved by the owner) as data: land and water,
 * districts, and the corridors the street grid leaves room for. Coordinates are metres from
 * the downtown spawn plaza (x east, z south), taken from the plan drawing at 4 m per pixel.
 */
import type { Rect } from './layout.ts';

/** The whole world square (WORLD_HALF = 1,536 m). */
export const WORLD: Rect = { x0: -1536, z0: -1536, x1: 1536, z1: 1536 };

/** Where streets and buildings go; the hills to the north stay open for now. */
export const DEVELOPED: Rect = { x0: -1200, z0: -840, x1: 1440, z1: 1220 };

/**
 * Los Soles is an island (owner, 2026-10-29: water all round, so nobody leaves the world).
 * Its coast as a closed loop with the land on the left: down the Pacific side, east along the
 * south shore, the harbour quay, up the east shore below the port, and west along the north
 * shore under the mountains.
 */
export const COAST: readonly [number, number][] = [
  [-1236, -1384],
  [-1280, -1056],
  [-1296, -616],
  [-1272, -216],
  [-1256, 184],
  [-1272, 544],
  [-1224, 864],
  [-1056, 1104],
  [-896, 1216],
  [-616, 1264],
  [-336, 1304],
  [-120, 1300],
  [200, 1290],
  [500, 1272],
  [704, 1252],
  // The harbour quay.
  [704, 1240],
  [1480, 1240],
  // The east shore.
  [1492, 960],
  [1484, 600],
  [1494, 240],
  [1486, -120],
  [1496, -480],
  [1484, -800],
  [1462, -1060],
  [1404, -1280],
  [1296, -1420],
  // The north shore.
  [1104, -1488],
  [800, -1504],
  [400, -1498],
  [0, -1494],
  [-400, -1500],
  [-760, -1490],
  [-1020, -1462],
  [-1176, -1424],
];
/** The harbour basin (water) in the south-east. */
export const HARBOUR: Rect = { x0: 704, z0: 1240, x1: 1536, z1: 1536 };

const LAND = COAST;

/**
 * The pier at the end of Grand Avenue (Beach City): a deck from the sand out over the sea,
 * widening into a platform for the Ferris wheel, then a last stretch to the end. Each piece
 * is walkable (deck top at the sidewalk height).
 */
export const PIER: readonly Rect[] = [
  { x0: -1380, z0: -9, x1: -1236, z1: 9 },
  { x0: -1460, z0: -32, x1: -1380, z1: 32 },
  { x0: -1500, z0: -9, x1: -1460, z1: 9 },
];

/** Where the pier leaves the coast (between these coast points, at z -9 … 9). */
function coastX(z: number): number {
  for (let i = 1; i < COAST.length; i += 1) {
    const [ax, az] = COAST[i - 1] as [number, number];
    const [bx, bz] = COAST[i] as [number, number];
    if (z >= az && z <= bz) return ax + ((z - az) / (bz - az)) * (bx - ax);
  }
  throw new Error(`no coast at z ${z}`);
}

/** The land plus the pier: where a body may stand (the server's water check, coast walls). */
const WALKABLE: readonly [number, number][] = (() => {
  const at = COAST.findIndex(([, z]) => z > 0);
  const [deck, platform, end] = PIER as [Rect, Rect, Rect];
  return [
    ...COAST.slice(0, at),
    [coastX(deck.z0), deck.z0],
    [platform.x1, deck.z0],
    [platform.x1, platform.z0],
    [platform.x0, platform.z0],
    [platform.x0, end.z0],
    [end.x0, end.z0],
    [end.x0, end.z1],
    [platform.x0, end.z1],
    [platform.x0, platform.z1],
    [platform.x1, platform.z1],
    [platform.x1, deck.z1],
    [coastX(deck.z1), deck.z1],
    ...LAND.slice(at),
  ] as [number, number][];
})();

/** The quarry's level floor, a pit cut into the north-east mountains (terrain.ts). */
export const QUARRY: Rect = { x0: 1040, z0: -1340, x1: 1360, z1: -1000 };

/**
 * The reservoir in the foothills (owner's reference: a lake in the mountains): an ellipse of
 * water in the canyon north of the stadium, at `level` m, its south end held by an earth dam
 * (terrain.ts shapes the basin, the rim and the dam).
 */
export const LAKE = { x: 835, z: -1150, rx: 72, rz: 46, level: 22 };

/**
 * Distance from (x, z) to the lake's edge (m), negative inside: the ellipse's implicit
 * function over its gradient, which is close to the true distance near the edge.
 */
export function lakeEdgeDistance(x: number, z: number): number {
  const dx = (x - LAKE.x) / LAKE.rx;
  const dz = (z - LAKE.z) / LAKE.rz;
  const r = Math.hypot(dx, dz);
  if (r < 1e-6) return -Math.min(LAKE.rx, LAKE.rz);
  const grad = Math.hypot(dx / LAKE.rx, dz / LAKE.rz) / r;
  return (r - 1) / grad;
}

/** In the lake's water (no swimming yet: bodies are kept out, as from the sea). */
export function inLake(x: number, z: number): boolean {
  return lakeEdgeDistance(x, z) < -1;
}

/** The concrete river channel, from the hills to the harbour. */
export const RIVER: Rect = { x0: 624, z0: -840, x1: 700, z1: 1240 };

/**
 * Freeway corridors kept free of grid streets and buildings. The freeways are up on decks only
 * around their interchange (owner, 2026-10-29: not to the end of the city); at each end they
 * come down to a junction and carry on at street level as a parkway. Where a freeway is
 * elevated its corridor is wide (the interchange's connectors run along the deck's sides);
 * along the parkways it is the parkway's width, sidewalks included.
 */
export const SOL_FREEWAY_Z = 212;
export const SOL_CORRIDOR: Rect = { x0: -1236, z0: 182, x1: 1536, z1: 242 };
export const SOL_ELEVATED: Rect = { x0: 240, z0: 182, x1: 960, z1: 242 };
export const VALLEY_FREEWAY_X = 600;
export const VALLEY_CORRIDOR: Rect = { x0: 566, z0: -1536, x1: 622, z1: 1240 };
export const VALLEY_ELEVATED: Rect = { x0: 566, z0: -240, x1: 622, z1: 720 };
/** Half the width of a parkway, sidewalks included (the freeway deck's carriageway plus 5 m). */
export const PARKWAY_HALF = 20;

export type District =
  | 'hills'
  | 'quarry'
  | 'beach'
  | 'palm_heights'
  | 'downtown'
  | 'stadium_hill'
  | 'mid_city'
  | 'arts'
  | 'south_grid'
  | 'eastside'
  | 'medical'
  | 'port'
  | 'river';

/** Checked in order: the first rectangle containing the point names its district. */
const DISTRICTS: readonly [District, Rect][] = [
  ['quarry', { x0: 1024, z0: -1536, x1: 1536, z1: -976 }],
  ['hills', { x0: -1536, z0: -1536, x1: 1536, z1: -840 }],
  ['river', RIVER],
  ['medical', { x0: 824, z0: -336, x1: 1224, z1: 24 }],
  ['stadium_hill', { x0: 224, z0: -840, x1: 560, z1: -576 }],
  ['beach', { x0: -1536, z0: -840, x1: -936, z1: 1536 }],
  ['palm_heights', { x0: -936, z0: -840, x1: -336, z1: 24 }],
  ['downtown', { x0: -336, z0: -576, x1: 560, z1: 104 }],
  ['mid_city', { x0: -936, z0: 24, x1: -336, z1: 704 }],
  ['arts', { x0: -336, z0: 104, x1: 624, z1: 704 }],
  ['south_grid', { x0: -936, z0: 704, x1: 624, z1: 1536 }],
  ['eastside', { x0: 700, z0: -840, x1: 1536, z1: 64 }],
  ['port', { x0: 700, z0: 64, x1: 1536, z1: 1536 }],
];

export function districtAt(x: number, z: number): District {
  for (const [name, r] of DISTRICTS) if (inside(r, x, z)) return name;
  return 'downtown';
}

export function inside(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

/** Dry land (the river channel counts as land: it's a concrete channel you can drive in). */
export function isLand(x: number, z: number): boolean {
  return inside(WORLD, x, z) && insidePolygon(LAND, x, z);
}

/** Land or the pier, out of the lake: anywhere a body may stand or drive. */
export function isWalkable(x: number, z: number): boolean {
  return inside(WORLD, x, z) && insidePolygon(WALKABLE, x, z) && !inLake(x, z);
}

/** Distance from (x, z) to the nearest point of the coast (m). */
export function coastDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = LAND.length - 1; i < LAND.length; j = i++) {
    const [ax, az] = LAND[j] as [number, number];
    const [bx, bz] = LAND[i] as [number, number];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/** Even-odd test against a closed polygon. */
function insidePolygon(poly: readonly [number, number][], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as [number, number];
    const [xj, zj] = poly[j] as [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** The land outline as a closed polygon (for drawing the ground and walling off the sea). */
export function landOutline(): [number, number][] {
  return LAND.map(([x, z]) => [x, z]);
}

/** The walkable outline (land and pier) as a closed polygon, for the walls along the sea. */
export function walkableOutline(): [number, number][] {
  return WALKABLE.map(([x, z]) => [x, z]);
}
