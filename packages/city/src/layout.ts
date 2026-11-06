/**
 * Los Soles city layout, generated from a seed so the world server (collision for movement
 * validation) and the client (rendering, physics) build exactly the same city.
 *
 * The whole city follows the approved plan (plan.ts, docs/city-plan.md): a 120 m street grid
 * whose density each district decides, main roads every 480 m, Sol Boulevard and Estrella
 * Boulevard with planted medians, the Sol and Valley freeways (on decks round their
 * interchange, parkways at street level beyond), the river
 * channel, and buildings styled by district. The prototype's downtown block keeps its streets,
 * plaza and names. Axis convention: x east, z south, y up.
 */
import type { ServiceId } from './interiors.ts';
import {
  DEVELOPED,
  type District,
  districtAt,
  inside,
  isLand,
  PARKWAY_HALF,
  RIVER,
  SOL_CORRIDOR,
  SOL_ELEVATED,
  SOL_FREEWAY_Z,
  VALLEY_CORRIDOR,
  VALLEY_ELEVATED,
  VALLEY_FREEWAY_X,
  WORLD,
} from './plan.ts';
import {
  isCityHallBlock,
  type Landmarks,
  makeLandmarks,
  placeCityHall,
  placeObservatory,
  type Solid,
} from './landmarks.ts';
import { type GuardRail, guardRails, HILL_HALF, type HillRoad } from './hillroads.ts';
import { type Dealership, dealership } from './dealership.ts';
import { type ParkingLot, parkingLots, placeLots } from './parking.ts';
import { cityPoints, type InteractionPoint } from './points.ts';
import { makeRamps, type Ramp, type RampPoint, rampHeightAt } from './ramps.ts';
import { hillRoads, hillVillas, terrainHeight } from './terrain.ts';
import { hash2, rng } from './random.ts';

export const CITY_SEED = 0x105_501e5;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Road {
  id: number;
  name: string;
  /** 'ns' roads run along z at x = center; 'ew' roads run along x at z = center. */
  axis: 'ns' | 'ew';
  center: number;
  /** Extent along the road's own axis. */
  from: number;
  to: number;
  lanesPerDir: number;
  laneWidth: number;
  /** Planted median width (0 = painted centre line). */
  median: number;
  sidewalk: number;
}

export type BuildingStyle =
  | 'glass_tower'
  | 'office_midrise'
  | 'deco'
  | 'stucco_shop'
  | 'brick_loft'
  | 'warehouse'
  | 'house'
  | 'villa'
  /** Landmarks built as buildings: city hall, the observatory (landmarks.ts). */
  | 'civic'
  /** The dealership's glass showroom (dealership.ts). */
  | 'showroom';

export interface Building {
  id: number;
  /** Footprint centre and size (x by z). */
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  floorHeight: number;
  style: BuildingStyle;
  seed: number;
  /** Ground under it (m) when not on the flat city (the observatory, the hill villas' pads). */
  y?: number;
  /** A public building (points.ts): the Police Station, the Hospital, a gang's house. */
  service?: ServiceId;
  /** A hill villa: its front faces north or south, and its drive runs to the road at z `toZ`. */
  drive?: { north: boolean; toZ: number };
}

/** Where a road crosses the river channel on a bridge (deck top at street level). */
export interface Bridge {
  /** The road's centre line (bridges run east–west across the river) and the span. */
  z: number;
  x0: number;
  x1: number;
  /** Half the width of the carriageway, and of the whole deck with its sidewalks. */
  carriage: number;
  half: number;
}

export interface Palm {
  x: number;
  z: number;
  height: number;
  seed: number;
}

export interface StreetLight {
  x: number;
  z: number;
  /** Direction the arm points (towards the road), radians. */
  yaw: number;
  /** On a hill road: the ground under the pole, and the road's rise per metre along it. */
  y?: number;
  grade?: number;
}

export interface Pillar {
  x: number;
  z: number;
  w: number;
  d: number;
}

/**
 * An elevated freeway: a straight deck along its axis at `center`, from `from` to `to` (its
 * descents to the street at each end are ramps).
 */
export interface Freeway {
  name: string;
  axis: 'ns' | 'ew';
  center: number;
  from: number;
  to: number;
  deckY: number;
  width: number;
  pillars: Pillar[];
}

export interface Spot {
  x: number;
  z: number;
  yaw: number;
}

export interface VehicleSpawn extends Spot {
  model: number;
  color: number;
}

export interface CityLayout {
  seed: number;
  bounds: Rect;
  roads: Road[];
  blocks: Rect[];
  plaza: Rect;
  buildings: Building[];
  palms: Palm[];
  lights: StreetLight[];
  freeways: Freeway[];
  /** The interchange's connectors and the freeways' street ramps (ramps.ts). */
  ramps: Ramp[];
  /** The roads winding up through the hills (hillroads.ts), graded into the terrain. */
  hillRoads: HillRoad[];
  /** Guard rails where the ground falls away beside them. */
  guardRails: GuardRail[];
  bridges: Bridge[];
  landmarks: Landmarks;
  /** Boxes bodies can't pass through besides buildings and pillars (landmarks.ts). */
  solids: Solid[];
  playerSpawns: Spot[];
  vehicleSpawns: VehicleSpawn[];
  /** Places a player can use (points.ts), named by index on client and server alike. */
  points: InteractionPoint[];
  /** Car parks where players get their own car (parking.ts). */
  parking: ParkingLot[];
  /** Car Dealership, where cars are bought (dealership.ts). */
  dealership: Dealership | null;
}

/** Half the paved width of a road including its sidewalks. */
export function roadHalfWidth(r: Road): number {
  return r.lanesPerDir * r.laneWidth + r.median / 2 + r.sidewalk;
}

/** Half the width of the carriageway (curb to curb). */
export function carriageHalfWidth(r: Road): number {
  return r.lanesPerDir * r.laneWidth + r.median / 2;
}

/** Street grid pitch: every line is a multiple of this from the plaza. */
const PITCH = 120;
/** Main roads (two lanes each way): every 480 m, plus the downtown grid of the prototype. */
const NS_ARTERIALS = new Set([-960, -480, 0, 480, 1080]);
const EW_ARTERIALS = new Set([-240, 360, 720, 1080]);
/** The Boulevard: the east–west nightlife strip (wide, planted median). */
const BOULEVARD_Z = -600;

/** Names kept from the prototype block, then original names for the rest of the city. */
const NS_NAMES: Record<number, string> = {
  [-240]: 'Figueroa St',
  [-120]: 'Hope St',
  0: 'Sol Boulevard',
  120: 'Main St',
  240: 'Alameda St',
};
const EW_NAMES: Record<number, string> = {
  [-240]: '9th St',
  [-120]: '7th St',
  0: 'Grand Avenue',
  120: '3rd St',
  [BOULEVARD_Z]: 'Estrella Boulevard',
};
const AVENUES = [
  'Ocean Ave',
  'Palisade Ave',
  'Vista St',
  'Laurel Ave',
  'Fairview Ave',
  'Crescent Ave',
  'Sierra St',
  'Mission Rd',
  'Arroyo St',
  'Camino Real',
  'Olive St',
  'Cypress Ave',
  'Harbor Blvd',
  'Dock St',
  'Mesa Ave',
  'Canyon Dr',
  'Orchard Ave',
  'Pacific Ave',
  'Redwood St',
  'Bonita Ave',
  'Rosa St',
  'Granada Ave',
];

/** Does a street run along this line through this district? */
function wantsLine(district: District, line: number, arterial: boolean): boolean {
  if (arterial) return true;
  switch (district) {
    case 'hills':
    case 'quarry':
    case 'stadium_hill':
    case 'river':
      return false;
    case 'port':
      // Big lots for warehouses and container yards.
      return line % (PITCH * 2) === 0;
    default:
      return true;
  }
}

export function generateCity(seed = CITY_SEED): CityLayout {
  const bounds: Rect = { ...WORLD };
  const roads = makeRoads();
  // The freeways and their ramps; streets they cross too low to pass under are cut back.
  const freeways = makeFreeways(roads);
  const ramps = makeRamps(roads, freeways);
  cutUnderDescents(roads, ramps);
  const blocks = makeBlocks(roads);
  // Stadium Hill west of Camino Real has no streets: its blocks are one lot, the stadium's.
  const onHill = blocks.filter(
    (b) => districtAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) === 'stadium_hill' && b.x1 < 480,
  );
  const stadiumLot: Rect = {
    x0: Math.min(...onHill.map((b) => b.x0)),
    z0: Math.min(...onHill.map((b) => b.z0)),
    x1: Math.max(...onHill.map((b) => b.x1)),
    z1: Math.max(...onHill.map((b) => b.z1)),
  };
  blocks.splice(0, blocks.length, ...blocks.filter((b) => !onHill.includes(b)), stadiumLot);
  const plaza = blocks.find((b) => b.x1 <= 0 && b.x0 >= -130 && b.z1 <= 0 && b.z0 >= -130);
  if (!plaza) throw new Error('layout has no plaza block');

  const buildings: Building[] = [];
  const palms: Palm[] = [];
  let cityHallBlock: Rect | null = null;
  for (const block of blocks) {
    if (block === plaza) continue;
    if (isCityHallBlock(block)) {
      cityHallBlock = block;
      placeCityHall(block, seed, buildings);
    } else fillBlock(block, roads, seed, buildings);
  }
  if (!cityHallBlock) throw new Error('layout has no city hall block');
  placeObservatory(seed, buildings);
  for (const v of hillVillas()) {
    buildings.push({
      id: buildings.length,
      x: v.x,
      z: v.z,
      w: v.w,
      d: v.d,
      h: v.h,
      floorHeight: STYLE_HEIGHTS.villa[2],
      style: 'villa',
      seed: v.seed,
      y: v.y,
      drive: { north: v.north, toZ: v.toZ },
    });
  }
  const { landmarks, solids } = makeLandmarks(cityHallBlock, stadiumLot);
  // Nothing is built under a ramp.
  const clear = buildings.filter((b) => !ramps.some((r) => underRamp(r, b)));
  // A building a district gives way to a car park (parking.ts).
  const { lots, replaced } = parkingLots(roads, clear, blocks);
  // And one on Sol Boulevard to the dealership's forecourt, its showroom built at the back.
  const dealer = dealership(
    roads,
    clear.map((b, i) => (replaced.has(i) ? { ...b, style: 'civic' as const } : b)),
  );
  if (dealer) replaced.add(dealer.replaced);
  const kept = clear.filter((_, i) => !replaced.has(i));
  if (dealer) kept.push(dealer.lot.showroom);
  kept.forEach((b, i) => (b.id = i));
  buildings.length = 0;
  buildings.push(...kept);
  const points = cityPoints(plaza, roads, buildings, seed, lots, dealer?.lot);
  solids.push(...points.solids);
  // Parking beside the places people go. New points go last, so older ones keep their index.
  const nearLots = placeLots(
    roads,
    buildings,
    points.points.flatMap((p) => {
      const name =
        p.kind === 'entrance' || p.kind === 'dock' || p.kind === 'buyer'
          ? p.name
          : p.kind === 'black_market'
            ? 'Container Yard'
            : p.kind === 'dealer'
              ? 'Dealership'
              : undefined;
      return name ? [{ x: p.x, z: p.z, name }] : [];
    }),
    points.points.filter((p) => p.x < 3000),
    lots,
  );
  lots.push(...nearLots);
  for (const lot of nearLots)
    points.points.push({ kind: 'parking', ...lot.entrance, radius: 5, name: lot.name });
  plantPlaza(plaza, seed, palms);
  plantBoulevards(roads, seed, palms);
  plantPalmHeights(roads, seed, palms);

  return {
    seed,
    bounds,
    roads,
    blocks,
    plaza,
    buildings,
    palms,
    // Nothing stands in a doorway or across the way into a car park.
    lights: [...placeLights(roads), ...hillLights(hillRoads())].filter(
      (l) =>
        !points.points.some(
          (p) =>
            (p.kind === 'entrance' || p.kind === 'parking') && Math.hypot(p.x - l.x, p.z - l.z) < 6,
        ),
    ),
    freeways,
    ramps,
    hillRoads: hillRoads(),
    guardRails: guardRails(hillRoads(), terrainHeight),
    bridges: roads
      .filter((r) => r.axis === 'ew' && r.from < RIVER.x0 && r.to > RIVER.x1)
      .map((r) => ({
        z: r.center,
        x0: RIVER.x0,
        x1: RIVER.x1,
        carriage: carriageHalfWidth(r),
        half: roadHalfWidth(r),
      })),
    landmarks,
    solids,
    playerSpawns: plazaSpawns(plaza),
    vehicleSpawns: parkedCars(roads, seed),
    points: points.points,
    parking: lots,
    dealership: dealer?.lot ?? null,
  };
}

/** Below this clearance under a descent (m), a street crossing beneath it is cut back. */
const MIN_CLEARANCE = 4;

/**
 * Cuts streets that would pass under a freeway's descent too low to drive beneath back to the
 * junctions either side of the freeway's corridor (as real freeways cut side streets).
 */
function cutUnderDescents(roads: Road[], ramps: Ramp[]) {
  for (const ramp of ramps) {
    if (ramp.kind !== 'descent') continue;
    const first = ramp.points[0] as RampPoint;
    const last = ramp.points[ramp.points.length - 1] as RampPoint;
    const axis = first.z === last.z ? 'ew' : 'ns';
    const band = axis === 'ew' ? SOL_CORRIDOR : VALLEY_CORRIDOR;
    for (let i = roads.length - 1; i >= 0; i -= 1) {
      const r = roads[i] as Road;
      if (r.axis === axis) continue;
      const across = axis === 'ew' ? first.z : first.x;
      if (across < r.from || across > r.to) continue;
      // Only streets crossing between its top and its foot (it lands at the next one's edge).
      const [a0, a1] = axis === 'ew' ? [first.x, last.x] : [first.z, last.z];
      if (r.center <= Math.min(a0, a1) || r.center >= Math.max(a0, a1)) continue;
      const [x, z] = r.axis === 'ns' ? [r.center, across] : [across, r.center];
      const y = rampHeightAt(ramp, x, z);
      if (y === null || y - ramp.depth >= MIN_CLEARANCE) continue;
      const [lo, hi] = axis === 'ew' ? [band.z0, band.z1] : [band.x0, band.x1];
      const pieces = [
        { ...r, to: Math.floor(lo / PITCH) * PITCH },
        { ...r, from: Math.ceil(hi / PITCH) * PITCH },
      ].filter((p) => p.to - p.from > 1);
      roads.splice(i, 1, ...pieces);
    }
  }
  roads.forEach((r, i) => (r.id = i));
}

/** Does a ramp pass over (or near) a building's footprint? */
function underRamp(ramp: Ramp, b: Building): boolean {
  // Most buildings are nowhere near: check the ramp's bounds first.
  const reach = ramp.width / 2 + 4;
  const xs = ramp.points.map((p) => p.x);
  const zs = ramp.points.map((p) => p.z);
  if (
    b.x + b.w / 2 < Math.min(...xs) - reach ||
    b.x - b.w / 2 > Math.max(...xs) + reach ||
    b.z + b.d / 2 < Math.min(...zs) - reach ||
    b.z - b.d / 2 > Math.max(...zs) + reach
  )
    return false;
  for (let x = b.x - b.w / 2; x <= b.x + b.w / 2 + 1e-6; x += Math.min(4, b.w)) {
    for (let z = b.z - b.d / 2; z <= b.z + b.d / 2 + 1e-6; z += Math.min(4, b.d)) {
      if (rampHeightAt(ramp, x, z, 4) !== null) return true;
    }
  }
  return false;
}

function roadSpec(axis: 'ns' | 'ew', line: number, arterial: boolean, name: string) {
  const boulevard = (axis === 'ns' && line === 0) || (axis === 'ew' && line === BOULEVARD_Z);
  // Grand Avenue, the plaza's wide south side, as in the prototype.
  const grand = axis === 'ew' && line === 0;
  // The prototype's downtown streets keep their two lanes each way.
  const downtownGrid = Math.abs(line) <= 240;
  return {
    name,
    axis,
    center: line,
    lanesPerDir: boulevard || grand ? 3 : arterial || downtownGrid ? 2 : 1,
    laneWidth: 3.5,
    median: boulevard ? 6 : 0,
    sidewalk: boulevard ? 6 : grand ? 5 : arterial || downtownGrid ? 4.5 : 3.5,
  };
}

/**
 * Streets along every grid line, in segments: a line is paved through each 120 m cell whose
 * district wants it, on land, inside the developed area, and outside the freeway corridors
 * (streets pass under the elevated decks).
 */
function makeRoads(): Road[] {
  const roads: Road[] = [];
  let avenue = 0;
  const add = (axis: 'ns' | 'ew', line: number, cells: [number, number][]) => {
    if (cells.length === 0) return;
    const arterial =
      axis === 'ns' ? NS_ARTERIALS.has(line) : EW_ARTERIALS.has(line) || line === BOULEVARD_Z;
    const named = axis === 'ns' ? NS_NAMES[line] : EW_NAMES[line];
    const name =
      named ??
      (axis === 'ew' && line > 0
        ? `${Math.round(line / PITCH) + 3}th St`
        : (AVENUES[avenue++ % AVENUES.length] ?? `Avenue ${avenue}`));
    for (const [from, to] of cells) {
      roads.push({ id: roads.length, from, to, ...roadSpec(axis, line, arterial, name) });
    }
  };
  for (let x = Math.ceil(DEVELOPED.x0 / PITCH) * PITCH; x <= DEVELOPED.x1; x += PITCH) {
    if (x > VALLEY_CORRIDOR.x0 - 10 && x < RIVER.x1 + 10) continue;
    add('ns', x, segmentsAlong('ns', x));
  }
  for (let z = Math.ceil(DEVELOPED.z0 / PITCH) * PITCH; z <= DEVELOPED.z1; z += PITCH) {
    if (z > SOL_CORRIDOR.z0 - 10 && z < SOL_CORRIDOR.z1 + 10) continue;
    add('ew', z, segmentsAlong('ew', z));
  }
  // The parkways the freeways carry on as at street level, from each end of the elevated
  // stretch to the last street crossing the corridor: the deck's lanes, a narrow planted
  // median where its centre barrier was, and sidewalks.
  const parkway = (axis: 'ns' | 'ew', center: number, from: number, to: number, name: string) =>
    roads.push({
      id: roads.length,
      name,
      axis,
      center,
      from,
      to,
      lanesPerDir: 4,
      laneWidth: 3.6,
      median: 1.2,
      sidewalk: PARKWAY_HALF - (4 * 3.6 + 0.6),
    });
  const crossings = (axis: 'ns' | 'ew', at: number) =>
    roads.filter((r) => r.axis !== axis && at >= r.from && at <= r.to).map((r) => r.center);
  const solX = crossings('ew', SOL_FREEWAY_Z);
  parkway('ew', SOL_FREEWAY_Z, Math.min(...solX), SOL_ELEVATED.x0, 'Sol Parkway');
  parkway('ew', SOL_FREEWAY_Z, SOL_ELEVATED.x1, Math.max(...solX), 'Sol Parkway');
  const valleyZ = crossings('ns', VALLEY_FREEWAY_X);
  parkway('ns', VALLEY_FREEWAY_X, Math.min(...valleyZ), VALLEY_ELEVATED.z0, 'Valley Parkway');
  parkway('ns', VALLEY_FREEWAY_X, VALLEY_ELEVATED.z1, Math.max(...valleyZ), 'Valley Parkway');
  return roads;
}

/** Bands kept clear of blocks: the freeways (wide where elevated), and the river. */
const CLEAR_BANDS: readonly Rect[] = [
  SOL_ELEVATED,
  { ...SOL_CORRIDOR, z0: SOL_FREEWAY_Z - PARKWAY_HALF, z1: SOL_FREEWAY_Z + PARKWAY_HALF },
  VALLEY_ELEVATED,
  { ...VALLEY_CORRIDOR, x0: VALLEY_FREEWAY_X - PARKWAY_HALF, x1: VALLEY_FREEWAY_X + PARKWAY_HALF },
  RIVER,
];

/** The wanted cells along a line, merged into continuous segments (ends on grid lines). */
function segmentsAlong(axis: 'ns' | 'ew', line: number): [number, number][] {
  const arterial =
    axis === 'ns' ? NS_ARTERIALS.has(line) : EW_ARTERIALS.has(line) || line === BOULEVARD_Z;
  const lo = axis === 'ns' ? DEVELOPED.z0 : DEVELOPED.x0;
  const hi = axis === 'ns' ? DEVELOPED.z1 : DEVELOPED.x1;
  const out: [number, number][] = [];
  let open: number | null = null;
  for (let a = Math.floor(lo / PITCH) * PITCH; a < hi; a += PITCH) {
    const mid = a + PITCH / 2;
    const [x, z] = axis === 'ns' ? [line, mid] : [mid, line];
    const [x0, z0] = axis === 'ns' ? [line, a] : [a, line];
    const [x1, z1] = axis === 'ns' ? [line, a + PITCH] : [a + PITCH, line];
    const ok =
      a >= lo - 1e-6 &&
      a + PITCH <= hi + 1e-6 &&
      isLand(x0, z0) &&
      isLand(x1, z1) &&
      wantsLine(districtAt(x, z), axis === 'ns' ? line : line, arterial);
    if (ok && open === null) open = a;
    if (!ok && open !== null) {
      out.push([open, a]);
      open = null;
    }
  }
  if (open !== null) out.push([open, Math.floor(hi / PITCH) * PITCH]);
  return out;
}

/** Is there a road along this line at this point (within its segment)? */
function roadAt(roads: Road[], axis: 'ns' | 'ew', line: number, along: number): Road | undefined {
  return roads.find(
    (r) => r.axis === axis && r.center === line && along >= r.from - 1e-6 && along <= r.to + 1e-6,
  );
}

/**
 * City blocks: each 120 m grid cell, inset by the half-width of the road on each side that
 * has one, clipped clear of the freeway corridors and the river, kept only on land.
 */
function makeBlocks(roads: Road[]): Rect[] {
  const blocks: Rect[] = [];
  const x0 = Math.floor(DEVELOPED.x0 / PITCH) * PITCH;
  const z0 = Math.floor(DEVELOPED.z0 / PITCH) * PITCH;
  for (let cx = x0; cx < DEVELOPED.x1; cx += PITCH) {
    for (let cz = z0; cz < DEVELOPED.z1; cz += PITCH) {
      const midX = cx + PITCH / 2;
      const midZ = cz + PITCH / 2;
      const inset = (axis: 'ns' | 'ew', line: number, along: number) => {
        const r = roadAt(roads, axis, line, along);
        return r ? roadHalfWidth(r) : 0;
      };
      let block: Rect | null = {
        x0: cx + inset('ns', cx, midZ),
        x1: cx + PITCH - inset('ns', cx + PITCH, midZ),
        z0: cz + inset('ew', cz, midX),
        z1: cz + PITCH - inset('ew', cz + PITCH, midX),
      };
      for (const band of CLEAR_BANDS) {
        block = block && clipOut(block, band);
      }
      if (!block) continue;
      if (block.x1 - block.x0 < 14 || block.z1 - block.z0 < 14) continue;
      const corners: [number, number][] = [
        [block.x0, block.z0],
        [block.x1, block.z0],
        [block.x0, block.z1],
        [block.x1, block.z1],
      ];
      if (!corners.every(([x, z]) => isLand(x, z) && inside(DEVELOPED, x, z))) continue;
      blocks.push(block);
    }
  }
  return blocks;
}

/** `r` minus `band`: the larger remaining piece (bands span a whole axis), or null. */
function clipOut(r: Rect, band: Rect): Rect | null {
  const overlapX = r.x1 > band.x0 && r.x0 < band.x1;
  const overlapZ = r.z1 > band.z0 && r.z0 < band.z1;
  if (!overlapX || !overlapZ) return r;
  const pieces: Rect[] = [];
  // Bands are long and thin: cut across their short axis.
  if (band.x1 - band.x0 < band.z1 - band.z0) {
    if (band.x0 > r.x0) pieces.push({ ...r, x1: Math.min(r.x1, band.x0) });
    if (band.x1 < r.x1) pieces.push({ ...r, x0: Math.max(r.x0, band.x1) });
  } else {
    if (band.z0 > r.z0) pieces.push({ ...r, z1: Math.min(r.z1, band.z0) });
    if (band.z1 < r.z1) pieces.push({ ...r, z0: Math.max(r.z0, band.z1) });
  }
  const area = (p: Rect) => (p.x1 - p.x0) * (p.z1 - p.z0);
  return pieces.sort((a, b) => area(b) - area(a))[0] ?? null;
}

const STYLE_HEIGHTS: Record<BuildingStyle, [number, number, number]> = {
  // min height, max height, floor height
  glass_tower: [60, 190, 4],
  office_midrise: [24, 55, 3.8],
  deco: [30, 70, 4.2],
  stucco_shop: [5, 13, 4.2],
  brick_loft: [14, 28, 4],
  warehouse: [8, 12, 6],
  house: [4, 8, 3.2],
  villa: [7, 10, 3.6],
  civic: [10, 104, 4.5],
  showroom: [8, 8, 4],
};

/** How each district builds: styles to pick from, lot widths, and how far it stands back. */
interface DistrictBuild {
  styles: readonly BuildingStyle[];
  width: [number, number];
  setback: [number, number];
  /** Fraction of lots left empty (yards, parking). */
  empty: number;
  /** Split blocks into front and back rows of lots. */
  rows: boolean;
}
const BUILD: Partial<Record<District, DistrictBuild>> = {
  downtown: {
    styles: ['glass_tower', 'glass_tower', 'deco', 'office_midrise'],
    width: [32, 48],
    setback: [3, 7],
    empty: 0,
    rows: false,
  },
  arts: {
    styles: ['brick_loft', 'brick_loft', 'warehouse', 'stucco_shop'],
    width: [18, 34],
    setback: [0, 2],
    empty: 0.05,
    rows: true,
  },
  palm_heights: { styles: ['villa'], width: [26, 36], setback: [6, 10], empty: 0.1, rows: true },
  mid_city: {
    styles: ['stucco_shop', 'office_midrise', 'house', 'house'],
    width: [14, 24],
    setback: [1, 4],
    empty: 0.08,
    rows: true,
  },
  south_grid: {
    styles: ['house', 'house', 'house', 'stucco_shop'],
    width: [11, 16],
    setback: [3, 5],
    empty: 0.12,
    rows: true,
  },
  eastside: {
    styles: ['house', 'house', 'stucco_shop', 'brick_loft'],
    width: [11, 18],
    setback: [2, 5],
    empty: 0.1,
    rows: true,
  },
  medical: {
    styles: ['office_midrise', 'office_midrise', 'deco'],
    width: [30, 46],
    setback: [6, 10],
    empty: 0.1,
    rows: false,
  },
  port: { styles: ['warehouse'], width: [40, 70], setback: [4, 8], empty: 0.15, rows: false },
  beach: {
    styles: ['stucco_shop', 'house', 'villa'],
    width: [14, 22],
    setback: [2, 5],
    empty: 0.15,
    rows: true,
  },
};

function fillBlock(block: Rect, roads: Road[], seed: number, out: Building[]) {
  const cx = (block.x0 + block.x1) / 2;
  const cz = (block.z0 + block.z1) / 2;
  const r = rng(hash2(seed, hash2(Math.round(cx), Math.round(cz))));
  const district = districtAt(cx, cz);
  // Stadium Hill: the stadium (a landmark) on its lot; the rest stays open.
  if (district === 'stadium_hill') return;
  const build = BUILD[district];
  if (!build) return;
  const nearFreeway = Math.abs(cz - SOL_FREEWAY_Z) < 70 || Math.abs(cx - VALLEY_FREEWAY_X) < 70;
  const onBoulevard = roads.some(
    (road) =>
      road.median > 0 &&
      road.axis === 'ns' &&
      Math.min(Math.abs(block.x0 - road.center), Math.abs(block.x1 - road.center)) < 25,
  );

  // Two rows of lots back to back (front facing north, back facing south), each split along x.
  const depth = block.z1 - block.z0;
  const rows: Rect[] =
    depth > 60 && build.rows
      ? [
          { ...block, z1: block.z0 + depth / 2 },
          { ...block, z0: block.z0 + depth / 2 },
        ]
      : [block];

  for (const row of rows) {
    // In neighbourhoods, shops and offices line the main roads; side streets are homes.
    const homesOnly =
      RESIDENTIAL.has(district) && !facesMainRoad(roads, block, row === rows[0], cx);
    let x = row.x0;
    while (row.x1 - x > 8) {
      const style: BuildingStyle =
        nearFreeway && district !== 'downtown'
          ? r.pick(['warehouse', 'brick_loft', 'warehouse'] as const)
          : onBoulevard && district !== 'downtown'
            ? r.pick(['stucco_shop', 'stucco_shop', 'brick_loft', 'deco'] as const)
            : homesOnly
              ? 'house'
              : r.pick(build.styles);
      const tower = style === 'glass_tower' || style === 'deco';
      let width = tower
        ? r.range(32, 48)
        : style === 'warehouse'
          ? r.range(28, 70)
          : r.range(...build.width);
      if (row.x1 - (x + width) < 12) width = row.x1 - x;
      const setback = tower
        ? r.range(3, 7)
        : style === 'stucco_shop'
          ? 0
          : r.range(...build.setback);
      // Gaps between neighbours, never leaving less than 9 m of building.
      const gap = Math.min(
        Math.max(0, width - 9),
        style === 'house' || style === 'villa' ? r.range(2, 5) : r.chance(0.3) ? r.range(1, 3) : 0,
      );
      const w = width - gap;
      const d = Math.min(
        row.z1 - row.z0 - setback * 2,
        style === 'house' ? r.range(10, 16) : style === 'villa' ? r.range(16, 24) : Infinity,
      );
      // A lot too small to build on is skipped, not the end of the row.
      if (w < 8 || d < 8) {
        x += width;
        continue;
      }
      if (r.chance(build.empty)) {
        x += width;
        continue;
      }
      const [hMin, hMax, floor] = STYLE_HEIGHTS[style];
      // Downtown's tallest towers cluster west of Sol Boulevard to shape the skyline.
      const skyline = district === 'downtown' ? 1 + Math.max(0, -cx - 60) / 120 : 1;
      const h = Math.min(hMax * 1.25, r.range(hMin, hMax) * skyline);
      // Houses and villas sit at the front of their lot, gardens behind.
      const zMid =
        style === 'house' || style === 'villa'
          ? row === rows[0]
            ? row.z0 + setback + d / 2
            : row.z1 - setback - d / 2
          : (row.z0 + row.z1) / 2;
      out.push({
        id: out.length,
        x: x + w / 2,
        z: zMid,
        w,
        d,
        h: Math.max(floor, Math.round(h / floor) * floor),
        floorHeight: floor,
        style,
        seed: hash2(seed, out.length + 1),
      });
      x += width;
    }
  }
}

/** Districts of homes, where only rows facing a main road get shops and offices. */
const RESIDENTIAL = new Set<District>(['mid_city', 'south_grid', 'eastside', 'beach']);

/**
 * Does this row of a block front a main road (two or more lanes each way)? The first row
 * faces the street on the block's north edge, the second the one on its south edge.
 */
function facesMainRoad(roads: Road[], block: Rect, northRow: boolean, at: number): boolean {
  return roads.some((r) => {
    if (r.axis !== 'ew' || r.lanesPerDir < 2 || at < r.from || at > r.to) return false;
    const edge = northRow ? r.center + roadHalfWidth(r) : r.center - roadHalfWidth(r);
    return Math.abs(edge - (northRow ? block.z0 : block.z1)) < 0.01;
  });
}

function plantPlaza(plaza: Rect, seed: number, out: Palm[]) {
  const r = rng(hash2(seed, 0x91a2a));
  const step = 14;
  for (let x = plaza.x0 + 7; x < plaza.x1 - 4; x += step) {
    for (let z = plaza.z0 + 7; z < plaza.z1 - 4; z += step) {
      const cx = (plaza.x0 + plaza.x1) / 2;
      const cz = (plaza.z0 + plaza.z1) / 2;
      // Keep the middle open around the fountain.
      if (Math.hypot(x - cx, z - cz) < 22) continue;
      if (!r.chance(0.55)) continue;
      out.push({
        x: x + r.range(-2, 2),
        z: z + r.range(-2, 2),
        height: r.range(9, 17),
        seed: hash2(seed, out.length + 7),
      });
    }
  }
}

/** Does a road of the other axis actually cross `road` at `along` (within its segment)? */
function crossesAt(roads: Road[], road: Road, along: number, margin: number): boolean {
  return roads.some(
    (c) =>
      c.axis !== road.axis &&
      Math.abs(along - c.center) < roadHalfWidth(c) + margin &&
      road.center >= c.from - 1e-6 &&
      road.center <= c.to + 1e-6,
  );
}

/** Is a point (on a road of `axis`) under a freeway deck or in the river channel? */
function underCorridor(x: number, z: number): boolean {
  return inside(SOL_ELEVATED, x, z) || inside(VALLEY_ELEVATED, x, z) || inside(RIVER, x, z);
}

/** Palms down both boulevards: in the median and along both sidewalks. */
function plantBoulevards(roads: Road[], seed: number, out: Palm[]) {
  const r = rng(hash2(seed, 0xb0b0));
  for (const road of roads) {
    if (road.median === 0) continue;
    const edge = carriageHalfWidth(road) + road.sidewalk * 0.6;
    for (let a = road.from + 6; a < road.to - 6; a += 12) {
      if (crossesAt(roads, road, a, 3)) continue;
      const at = (offset: number, shift: number): [number, number] =>
        road.axis === 'ns' ? [road.center + offset, a + shift] : [a + shift, road.center + offset];
      const [mx, mz] = at(0, 0);
      if (underCorridor(mx, mz)) continue;
      out.push({ x: mx, z: mz, height: r.range(18, 26), seed: hash2(seed, out.length + 101) });
      for (const side of [-1, 1]) {
        if (!r.chance(0.7)) continue;
        const [x, z] = at(side * edge, 6);
        if (underCorridor(x, z) || crossesAt(roads, road, a + 6, 3)) continue;
        out.push({ x, z, height: r.range(16, 24), seed: hash2(seed, out.length + 201) });
      }
    }
  }
}

/** Palm Heights: tall palms evenly down both sidewalks of every street. */
function plantPalmHeights(roads: Road[], seed: number, out: Palm[]) {
  const r = rng(hash2(seed, 0xa1a));
  for (const road of roads) {
    if (road.median > 0) continue;
    const edge = carriageHalfWidth(road) + road.sidewalk * 0.55;
    for (let a = road.from + 10; a < road.to - 10; a += 16) {
      if (crossesAt(roads, road, a, 4)) continue;
      for (const side of [-1, 1]) {
        const [x, z] =
          road.axis === 'ns' ? [road.center + side * edge, a] : [a, road.center + side * edge];
        if (districtAt(x, z) !== 'palm_heights' || underCorridor(x, z)) continue;
        out.push({ x, z, height: r.range(17, 25), seed: hash2(seed, out.length + 401) });
      }
    }
  }
}

function placeLights(roads: Road[]): StreetLight[] {
  const lights: StreetLight[] = [];
  for (const road of roads) {
    const off = carriageHalfWidth(road) + 0.8;
    for (let s = road.from + 15; s < road.to - 10; s += 30) {
      if (crossesAt(roads, road, s, 2) || crossesAt(roads, road, s + 15, 2)) continue;
      if (road.axis === 'ns') {
        if (underCorridor(road.center, s)) continue;
        lights.push({ x: road.center - off, z: s, yaw: Math.PI / 2 });
        lights.push({ x: road.center + off, z: s + 15, yaw: -Math.PI / 2 });
      } else {
        if (underCorridor(s, road.center)) continue;
        lights.push({ x: s, z: road.center - off, yaw: 0 });
        lights.push({ x: s + 15, z: road.center + off, yaw: Math.PI });
      }
    }
  }
  return lights;
}

/**
 * The decks of the Sol Freeway (east–west, at 10 m) and the Valley Freeway (north–south, at
 * 18 m, crossing over the Sol): level round the interchange, long enough for its connectors
 * to join them (ramps.ts); each comes down from its ends. Pillars stand every 32 m in pairs,
 * never on a street passing underneath.
 */
/**
 * Lamps along the hill roads every 36 m, on the shoulder of the downhill side (the light they
 * throw past the road's edge falls over the slope, not into a bank).
 */
function hillLights(roads: HillRoad[]): StreetLight[] {
  const out: StreetLight[] = [];
  for (const road of roads) {
    const pts = road.points;
    let next = 18;
    let walked = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1] as RampPoint;
      const b = pts[i] as RampPoint;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (; next <= walked + len; next += 36) {
        const t = (next - walked) / len;
        const [dx, dz] = [(b.x - a.x) / len, (b.z - a.z) / len];
        const [px, pz] = [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t];
        const below = (side: number) => terrainHeight(px - dz * 12 * side, pz + dx * 12 * side);
        const side = below(1) < below(-1) ? 1 : -1;
        const off = HILL_HALF + 1.2;
        const x = px - dz * off * side;
        const z = pz + dx * off * side;
        // Not where a road joins (the lamp would stand in the other road).
        if (roads.some((r) => r !== road && nearRoad(r, x, z, HILL_HALF + 1))) continue;
        // The arm points back across the road; the grade is along the road (the pool tilts).
        out.push({
          x,
          z,
          yaw: Math.atan2(dz * side, -dx * side),
          y: a.y + (b.y - a.y) * t,
          grade: (b.y - a.y) / len,
        });
      }
      walked += len;
    }
  }
  return out;
}

function nearRoad(road: HillRoad, x: number, z: number, d: number): boolean {
  return road.points.some((p) => Math.hypot(p.x - x, p.z - z) < d + 4);
}

function makeFreeways(roads: Road[]): Freeway[] {
  const deck = (
    name: string,
    axis: 'ns' | 'ew',
    center: number,
    from: number,
    to: number,
    deckY: number,
  ): Freeway => {
    const pillars: Pillar[] = [];
    for (let a = from + 16; a <= to - 16; a += 32) {
      const clearOfStreets = !roads.some(
        (c) =>
          c.axis !== axis &&
          Math.abs(a - c.center) < roadHalfWidth(c) + 3 &&
          center >= c.from - 1e-6 &&
          center <= c.to + 1e-6,
      );
      if (!clearOfStreets) continue;
      for (const off of [-9, 9]) {
        const [x, z] = axis === 'ew' ? [a, center + off] : [center + off, a];
        if (!isLand(x, z)) continue;
        // The Valley deck's pillars stay clear of the Sol deck below it.
        if (axis === 'ns' && inside(SOL_ELEVATED, x, z)) continue;
        pillars.push({ x, z, w: 2.2, d: 2.2 });
      }
    }
    return { name, axis, center, from, to, deckY, width: 30, pillars };
  };
  return [
    deck('Sol Freeway', 'ew', SOL_FREEWAY_Z, 465, 735, 10),
    deck('Valley Freeway', 'ns', VALLEY_FREEWAY_X, 80, 340, 18),
  ];
}

function plazaSpawns(plaza: Rect): Spot[] {
  const cx = (plaza.x0 + plaza.x1) / 2;
  const cz = (plaza.z0 + plaza.z1) / 2;
  const spawns: Spot[] = [];
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    spawns.push({ x: cx + Math.cos(a) * 30, z: cz + Math.sin(a) * 30, yaw: -a - Math.PI / 2 });
  }
  return spawns;
}

/**
 * How many everyday car models there are to park (the first models of shared CAR_MODELS,
 * its CIVILIAN_CARS; a test keeps them equal).
 */
export const PARKED_CAR_MODELS = 10;

/** Kerb spots round the plaza: no cars wait there now, but staff can move a stray car to one. */
function parkedCars(roads: Road[], seed: number): VehicleSpawn[] {
  const r = rng(hash2(seed, 0xca7));
  const spawns: VehicleSpawn[] = [];
  // The stretches beside the plaza (streets come in segments now).
  const grand = roadAt(roads, 'ew', 0, -60);
  const hope = roadAt(roads, 'ns', -120, -60);
  if (grand) {
    const z = grand.center - carriageHalfWidth(grand) + grand.laneWidth / 2;
    for (let x = -105; x < -20; x += 12)
      spawns.push({
        x,
        z,
        yaw: Math.PI / 2,
        model: r.int(0, PARKED_CAR_MODELS - 1),
        color: r.int(0, 7),
      });
  }
  if (hope) {
    const x = hope.center + carriageHalfWidth(hope) - hope.laneWidth / 2;
    for (let z = -105; z < -25; z += 12)
      spawns.push({
        x,
        z,
        yaw: Math.PI,
        model: r.int(0, PARKED_CAR_MODELS - 1),
        color: r.int(0, 7),
      });
  }
  return spawns;
}
