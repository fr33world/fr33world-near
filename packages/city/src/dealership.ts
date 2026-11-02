/**
 * The dealership (Phase 7): Car Dealership, on Sol Boulevard in the Arts District. A shop that
 * fronts the boulevard gives its plot to a forecourt: the cars for sale on show in two rows
 * facing the street (a front row of six, a second of four, angled out from a driveway down
 * the middle), a glass showroom at the back with the sales desk's marker at its door, and
 * delivery bays either side of it where a car just bought waits, nose to the street. Client
 * and server build the same one from the layout (deterministic).
 */
import type { Building, Rect, Road } from './layout.ts';
import { roadHalfWidth } from './layout.ts';
import type { Bay } from './parking.ts';

export interface Dealership {
  name: string;
  rect: Rect;
  /** Where the cars for sale stand, in the catalogue's order (shared DEALER_MODELS). */
  display: Bay[];
  /** Where a car just bought is brought, nearest the showroom first. */
  delivery: Bay[];
  /** The showroom (also in the layout's buildings). */
  showroom: Building;
  /** The sales desk: in front of the showroom's door, facing the street. */
  desk: { x: number; z: number; yaw: number };
  /** The pylon sign at the street, and which way it faces. */
  sign: { x: number; z: number; yaw: number };
}

/** The dealership's name, on its sign and the map. */
export const DEALER_NAME = 'Car Dealership';

/** The plot: on this boulevard, as near this spot as a shop allows. */
const STREET = 'Sol Boulevard';
const ANCHOR = { x: -36, z: 267 };
/** Plot size: along the street, and back from it (m). */
const MIN_LENGTH = 50;
const MAX_LENGTH = 64;
const MIN_DEPTH = 32;
const MAX_DEPTH = 44;

/** The showroom: width along the street, depth, height, and its gap to the plot's back. */
const SHOWROOM = { w: 18, d: 12, h: 8, back: 1 };

/** Display spots (u along the street from the plot's middle, v in from the street, splay). */
const DISPLAY: [number, number, number][] = [
  [-7.5, 6.5, -1],
  [7.5, 6.5, 1],
  [-15, 6.5, -1],
  [15, 6.5, 1],
  [-22.5, 6.5, -1],
  [22.5, 6.5, 1],
  [-10, 14.5, -1],
  [10, 14.5, 1],
  [-19, 14.5, -1],
  [19, 14.5, 1],
];
/** How far display cars turn out from facing the street (radians). */
const SPLAY = 0.42;
/** Delivery bays beside the showroom: u, either side. */
const DELIVERY_U = [12.5, 16, 19.5, 23];

/** The dealership's plot, and the building that gives way to it (by index in `buildings`). */
export function dealership(
  roads: Road[],
  buildings: Building[],
): { lot: Dealership; replaced: number } | null {
  let best: { i: number; d: number; r: Road; side: number } | null = null;
  buildings.forEach((b, i) => {
    if (b.style !== 'stucco_shop' && b.style !== 'brick_loft' && b.style !== 'deco') return;
    if (b.y !== undefined) return;
    for (const r of roads) {
      if (r.name !== STREET || r.axis !== 'ns') continue;
      if (b.z < r.from + 16 || b.z > r.to - 16) continue;
      const off = b.x - r.center;
      const gap = Math.abs(off) - b.w / 2 - roadHalfWidth(r);
      if (gap < -0.5 || gap > 4) continue;
      if (b.d < MIN_LENGTH || b.d > MAX_LENGTH || b.w < MIN_DEPTH || b.w > MAX_DEPTH) continue;
      const d = Math.hypot(b.x - ANCHOR.x, b.z - ANCHOR.z);
      if (!best || d < best.d) best = { i, d, r, side: Math.sign(off) };
    }
  });
  if (!best) return null;
  const { i, side } = best as { i: number; side: number };
  const b = buildings[i] as Building;
  const rect = { x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2 };
  // The street edge, and the way in from it (the boulevard runs north–south).
  const edge = side > 0 ? rect.x0 : rect.x1;
  const inward = side > 0 ? 1 : -1;
  const depth = b.w;
  const at = (u: number, v: number) => ({ x: edge + inward * v, z: b.z + u });
  // Facing the street: yaw towards -inward on x.
  const street = Math.atan2(-inward, 0);
  const display = DISPLAY.map(([u, v, s]) => ({
    ...at(u, v),
    // Nose turned out towards its own end of the plot (+u is +z).
    yaw: street + s * SPLAY * inward,
  }));
  const back = depth - SHOWROOM.back;
  const front = back - SHOWROOM.d;
  const mid = at(0, (front + back) / 2);
  const showroom: Building = {
    id: -1,
    x: mid.x,
    z: mid.z,
    w: SHOWROOM.d,
    d: SHOWROOM.w,
    h: SHOWROOM.h,
    floorHeight: SHOWROOM.h / 2,
    style: 'showroom',
    seed: b.seed,
  };
  // Backed up to the plot's back edge, leaving a wide aisle in front to drive out by.
  const bayV = back - 3;
  const delivery = DELIVERY_U.flatMap((u) => [at(-u, bayV), at(u, bayV)]).map((p) => ({
    ...p,
    yaw: street,
  }));
  return {
    lot: {
      name: DEALER_NAME,
      rect,
      display,
      delivery,
      showroom,
      desk: { ...at(0, front - 2.5), yaw: street },
      sign: { ...at(-(b.d / 2) + 2, 1.6), yaw: street },
    },
    replaced: i,
  };
}
