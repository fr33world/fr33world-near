/**
 * Parking lots (owner, 2026-10-30: lots across the map where players get their own car, only
 * where a car park belongs; then "we need more"). One or more a district, none closer than
 * MIN_APART to another: a building that fronts a street, of a car park's size, in a block with
 * others left standing, gives its footprint to a lot (two rows of bays either side of an aisle
 * that opens onto the street); and one on open ground by the quarry's gate. Client and server build the same lots from the layout (deterministic).
 */
import type { Building, Rect, Road } from './layout.ts';
import { roadHalfWidth } from './layout.ts';
import { districtAt, QUARRY } from './plan.ts';

export interface Bay {
  x: number;
  z: number;
  /** Which way a car parked in it faces (yaw: 0 = +z). */
  yaw: number;
}

export interface ParkingLot {
  name: string;
  rect: Rect;
  /** Where the lot meets the street (the player stands about here to call their car). */
  entrance: { x: number; z: number; yaw: number };
  bays: Bay[];
}

/** Bay width and length, and the aisle between the rows (m). */
const BAY_W = 2.7;
const BAY_L = 5.4;
const AISLE = 6.4;

/**
 * A lot in this district as near this spot as a building allows, and its name (downtown's
 * first: by the plaza). The first of each district came first and keep their names; the rest
 * were added for more places to get a car.
 */
const ANCHORS: [string, number, number, string][] = [
  ['downtown', -120, -150, 'Downtown'],
  ['arts', 150, 360, 'Arts District'],
  ['mid_city', -600, 320, 'Mid City'],
  ['palm_heights', -620, -420, 'Palm Heights'],
  ['south_grid', -300, 1000, 'South Grid'],
  ['eastside', 1000, -460, 'Eastside'],
  ['port', 1000, 520, 'Port'],
  ['medical', 1000, -150, 'Medical Center'],
  ['stadium_hill', 400, -700, 'Stadium'],
  ['downtown', 380, -380, 'Downtown East'],
  ['downtown', -200, 40, 'Downtown South'],
  ['arts', 480, 600, 'Arts District South'],
  ['arts', -200, 560, 'Arts District West'],
  ['mid_city', -760, 620, 'Mid City South'],
  ['mid_city', -450, 120, 'Mid City North'],
  ['palm_heights', -450, -120, 'Palm Heights South'],
  ['south_grid', 350, 1150, 'South Grid East'],
  ['south_grid', -750, 1300, 'South Grid West'],
  ['south_grid', -100, 1400, 'Ocean Front'],
  ['eastside', 820, -720, 'Eastside North'],
  ['port', 1200, 1050, 'Port South'],
  ['port', 820, 260, 'Port North'],
  ['beach', -1100, 100, 'Beach'],
];
/** No two lots nearer than this (m), so they spread over the map. */
const MIN_APART = 220;
const NO_LOT_STYLES = new Set(['civic', 'villa', 'stadium']);

/** The road a building fronts, its side, and how far off it is (as the delivery doors). */
function frontage(b: Building, roads: Road[]): { r: Road; side: number } | null {
  let best: { r: Road; side: number; gap: number } | null = null;
  for (const r of roads) {
    const along = r.axis === 'ns' ? b.z : b.x;
    if (along < r.from + 16 || along > r.to - 16) continue;
    const off = (r.axis === 'ns' ? b.x : b.z) - r.center;
    const half = (r.axis === 'ns' ? b.w : b.d) / 2;
    const gap = Math.abs(off) - half - roadHalfWidth(r);
    if (gap > -0.5 && gap < 4 && (!best || gap < best.gap)) best = { r, side: Math.sign(off), gap };
  }
  return best ? { r: best.r, side: best.side } : null;
}

/**
 * A lot on a rectangle that meets a street along one edge: `u` runs along the street, `v`
 * away from it. The aisle runs in from the street; bays line both its sides, noses to it.
 */
function lotOn(name: string, rect: Rect, street: 'x0' | 'x1' | 'z0' | 'z1'): ParkingLot {
  const alongX = street === 'z0' || street === 'z1';
  const length = alongX ? rect.x1 - rect.x0 : rect.z1 - rect.z0;
  const depth = alongX ? rect.z1 - rect.z0 : rect.x1 - rect.x0;
  // From the street edge inwards.
  const inward = street === 'x0' || street === 'z0' ? 1 : -1;
  const edge = rect[street];
  const mid = alongX ? (rect.x0 + rect.x1) / 2 : (rect.z0 + rect.z1) / 2;
  const at = (u: number, v: number) =>
    alongX ? { x: mid + u, z: edge + inward * v } : { x: edge + inward * v, z: mid + u };
  const bays: Bay[] = [];
  const rows = Math.floor((depth - 1.2) / BAY_W);
  for (const side of [-1, 1]) {
    const u = side * (AISLE / 2 + BAY_L / 2);
    if (Math.abs(u) + BAY_L / 2 > length / 2) continue;
    for (let k = 0; k < rows; k += 1) {
      const p = at(u, 1.2 + BAY_W / 2 + k * BAY_W);
      // Nose to the aisle: towards u = 0.
      const towards = at(0, 1.2 + BAY_W / 2 + k * BAY_W);
      bays.push({ ...p, yaw: Math.atan2(towards.x - p.x, towards.z - p.z) });
    }
  }
  const door = at(0, 1.5);
  const out = at(0, -3);
  return {
    name,
    rect,
    entrance: { ...door, yaw: Math.atan2(out.x - door.x, out.z - door.z) },
    bays,
  };
}

/**
 * The lots, and the buildings that give way to them (by index in `buildings`). Buildings with a
 * `drive`, on the hills, or of the landmark styles are never taken.
 */
export function parkingLots(
  roads: Road[],
  buildings: Building[],
  blocks: Rect[],
): { lots: ParkingLot[]; replaced: Set<number> } {
  const lots: ParkingLot[] = [];
  const replaced = new Set<number>();
  const blockOf = (b: Building) =>
    blocks.find((k) => b.x >= k.x0 && b.x <= k.x1 && b.z >= k.z0 && b.z <= k.z1);
  for (const [district, ax, az, name] of ANCHORS) {
    let best: { i: number; d: number; street: 'x0' | 'x1' | 'z0' | 'z1' } | null = null;
    buildings.forEach((b, i) => {
      if (replaced.has(i) || b.y !== undefined || b.drive || NO_LOT_STYLES.has(b.style)) return;
      if (districtAt(b.x, b.z) !== district) return;
      const f = frontage(b, roads);
      if (!f) return;
      const length = f.r.axis === 'ns' ? b.d : b.w;
      const depth = f.r.axis === 'ns' ? b.w : b.d;
      if (length < 2 * BAY_L + AISLE + 1 || length > 64 || depth < 3 * BAY_W + 1.2 || depth > 92)
        return;
      const block = blockOf(b);
      const others = block
        ? buildings.filter(
            (o) =>
              o !== b && o.x >= block.x0 && o.x <= block.x1 && o.z >= block.z0 && o.z <= block.z1,
          ).length
        : 0;
      if (others < 2) return;
      if (lots.some((l) => Math.hypot(l.entrance.x - b.x, l.entrance.z - b.z) < MIN_APART)) return;
      const d = Math.hypot(b.x - ax, b.z - az);
      if (best && d >= best.d) return;
      // The lot's street edge: the building's side towards the road.
      const street = f.r.axis === 'ns' ? (f.side > 0 ? 'x0' : 'x1') : f.side > 0 ? 'z0' : 'z1';
      best = { i, d, street };
    });
    if (!best) continue;
    const { i, street } = best as { i: number; d: number; street: 'x0' | 'x1' | 'z0' | 'z1' };
    const b = buildings[i] as Building;
    replaced.add(i);
    const rect = { x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2 };
    lots.push(lotOn(`${name} parking`, rect, street));
  }
  // By the quarry's gate, west of Quarry Road where it reaches the pit.
  lots.push(
    lotOn('Quarry parking', { x0: 1138, x1: 1168, z0: QUARRY.z1 - 64, z1: QUARRY.z1 - 40 }, 'x1'),
  );
  return { lots, replaced };
}

/** A place people go that should have parking close by. */
export interface ParkingTarget {
  x: number;
  z: number;
  name: string;
}

/** A target this close to a lot is served already (m). */
const SERVED_M = 120;
/** How far a building may be from the target, the slice it gives up, and what it keeps (m). */
const NEAR_TARGET_M = 130;
const SLICE_M = 24;
const KEEP_M = 22;

/**
 * Parking beside the places people go (owner, 2026-11-06). Runs after every point in the city is
 * placed: a nearby long building gives up the end nearest the target, shortened rather than
 * removed, so no door, shop or public building moves. An end with a point on it is left alone.
 */
export function placeLots(
  roads: Road[],
  buildings: Building[],
  targets: readonly ParkingTarget[],
  taken: readonly { x: number; z: number }[],
  have: readonly ParkingLot[],
): ParkingLot[] {
  const made: ParkingLot[] = [];
  for (const t of targets) {
    const lots = [...have, ...made];
    if (lots.some((l) => Math.hypot(l.entrance.x - t.x, l.entrance.z - t.z) < SERVED_M)) continue;
    const near = buildings
      .filter(
        (b) =>
          !b.service &&
          b.y === undefined &&
          !b.drive &&
          !NO_LOT_STYLES.has(b.style) &&
          Math.hypot(b.x - t.x, b.z - t.z) < NEAR_TARGET_M,
      )
      .sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
    for (const b of near) {
      const f = frontage(b, roads);
      if (!f) continue;
      const ns = f.r.axis === 'ns';
      const length = ns ? b.d : b.w;
      if (length < SLICE_M + KEEP_M) continue;
      // The end nearest the target, along the street.
      const end = (ns ? t.z - b.z : t.x - b.x) >= 0 ? 1 : -1;
      const far = (ns ? b.z : b.x) + (end * length) / 2;
      const near_ = far - end * SLICE_M;
      const lo = Math.min(far, near_);
      const hi = Math.max(far, near_);
      const rect = ns
        ? { x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: lo, z1: hi }
        : { x0: lo, x1: hi, z0: b.z - b.d / 2, z1: b.z + b.d / 2 };
      const pad = 3;
      const clash = taken.some(
        (p) =>
          p.x > rect.x0 - pad && p.x < rect.x1 + pad && p.z > rect.z0 - pad && p.z < rect.z1 + pad,
      );
      if (clash) continue;
      if (ns) {
        b.d -= SLICE_M;
        b.z -= (end * SLICE_M) / 2;
      } else {
        b.w -= SLICE_M;
        b.x -= (end * SLICE_M) / 2;
      }
      const street = ns ? (f.side > 0 ? 'x0' : 'x1') : f.side > 0 ? 'z0' : 'z1';
      made.push(lotOn(`${t.name} parking`, rect, street));
      break;
    }
    if (made.at(-1)?.name === `${t.name} parking`) continue;
    const lot = onHouses(roads, buildings, t, taken);
    if (lot) made.push(lot);
  }
  return made;
}

/**
 * Where a street of small houses leaves nothing to trim: two neighbours with nobody's door on them
 * make way. Safe here because every point is already placed, so nothing else moves.
 */
function onHouses(
  roads: Road[],
  buildings: Building[],
  t: ParkingTarget,
  taken: readonly { x: number; z: number }[],
): ParkingLot | null {
  const houses = buildings
    .filter((b) => b.style === 'house' && Math.hypot(b.x - t.x, b.z - t.z) < NEAR_TARGET_M)
    .sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
  for (const a of houses) {
    const f = frontage(a, roads);
    if (!f) continue;
    const ns = f.r.axis === 'ns';
    for (const b of houses) {
      if (b === a || frontage(b, roads)?.r !== f.r) continue;
      const gap = ns
        ? Math.abs(a.z - b.z) - (a.d + b.d) / 2
        : Math.abs(a.x - b.x) - (a.w + b.w) / 2;
      if (gap < 0 || gap > 6) continue;
      const rect = {
        x0: Math.min(a.x - a.w / 2, b.x - b.w / 2),
        x1: Math.max(a.x + a.w / 2, b.x + b.w / 2),
        z0: Math.min(a.z - a.d / 2, b.z - b.d / 2),
        z1: Math.max(a.z + a.d / 2, b.z + b.d / 2),
      };
      if ((ns ? rect.z1 - rect.z0 : rect.x1 - rect.x0) < 2 * BAY_L + AISLE + 1) continue;
      const pad = 3;
      if (
        taken.some(
          (p) =>
            p.x > rect.x0 - pad &&
            p.x < rect.x1 + pad &&
            p.z > rect.z0 - pad &&
            p.z < rect.z1 + pad,
        )
      )
        continue;
      for (const gone of [a, b]) buildings.splice(buildings.indexOf(gone), 1);
      const street = ns ? (f.side > 0 ? 'x0' : 'x1') : f.side > 0 ? 'z0' : 'z1';
      return lotOn(`${t.name} parking`, rect, street);
    }
  }
  return null;
}
