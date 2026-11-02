/**
 * Where the street props stand (props.ts draws them; physics.ts makes them solid): fire
 * hydrants at the junctions, bins along the busy sidewalks, benches facing the boulevards and
 * round the parks, planters downtown, and concrete barriers across streets that dead-end.
 * Worked out from the layout, so every client places them the same way.
 */
import {
  carriageHalfWidth,
  type CityLayout,
  type District,
  districtAt,
  hash2,
  inside,
  type Rect,
  type Road,
  rng,
  terrainHeight,
} from '@fr33world/city';
import { expandBySidewalks, SLAB_Y } from './city.ts';
import { junctions } from './junctions.ts';

export type PropKind = 'hydrant' | 'bin' | 'bench' | 'planter' | 'barrier';

export interface PropSpot {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  /** Turn about y (radians): the model's front (+z) faces (sin yaw, cos yaw). */
  yaw: number;
}

/** Footprints for the physics (half sizes, m) and heights. */
export const PROP_SIZE: Record<PropKind, { hx: number; hz: number; h: number }> = {
  hydrant: { hx: 0.18, hz: 0.18, h: 0.8 },
  bin: { hx: 0.3, hz: 0.3, h: 0.9 },
  bench: { hx: 0.6, hz: 0.25, h: 0.9 },
  planter: { hx: 0.74, hz: 0.34, h: 0.68 },
  barrier: { hx: 0.79, hz: 0.22, h: 1.1 },
};

const BUSY = new Set<District>(['downtown', 'arts', 'mid_city', 'medical', 'beach']);

/** A bus shelter: its middle, and the turn that faces its open front (+z) to the road. */
export interface ShelterSpot {
  x: number;
  z: number;
  yaw: number;
}

/** A shelter's size: along the road, deep, high (m). */
export const SHELTER = { w: 4.6, d: 1.6, h: 2.7 };

const shelterCache = new WeakMap<CityLayout, ShelterSpot[]>();

/**
 * Bus shelters on the main roads (two lanes each way or more), about every 360 m on
 * alternating sides, on the sidewalk facing the road, away from junctions (once per layout).
 */
export function shelterSpots(city: CityLayout): ShelterSpot[] {
  let spots = shelterCache.get(city);
  if (!spots) {
    spots = [];
    const pavements = city.blocks.map((b) => expandBySidewalks(b, city.roads));
    for (const road of city.roads) {
      if (road.lanesPerDir < 2 || road.sidewalk < 3.5) continue;
      let k = road.id % 2;
      // Street lights stand every 15 m, alternating sides, from 15 m in: 67.5 m puts a
      // shelter halfway between two.
      for (let s = road.from + 67.5; s < road.to - 60; s += 180, k += 1) {
        if (k % 2 === 1) continue;
        const clear = !city.roads.some(
          (c) =>
            c.axis !== road.axis &&
            Math.abs(s - c.center) < carriageHalfWidth(c) + 25 &&
            road.center >= c.from - 1 &&
            road.center <= c.to + 1,
        );
        if (!clear) continue;
        const side = (Math.floor(s / 180) + road.id) % 2 === 0 ? 1 : -1;
        const off = carriageHalfWidth(road) + Math.max(1.4, road.sidewalk * 0.55);
        const [x, z] =
          road.axis === 'ns' ? [road.center + side * off, s] : [s, road.center + side * off];
        if (!pavements.some((b) => inside(b, x, z))) continue;
        // Its front (+z) turned to face back across the road.
        const yaw =
          road.axis === 'ns' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0;
        spots.push({ x, z, yaw });
      }
    }
    shelterCache.set(city, spots);
  }
  return spots;
}

const propCache = new WeakMap<CityLayout, PropSpot[]>();
const treeCache = new WeakMap<CityLayout, TreeSpot[]>();

/** The props' spots (worked out once per layout: the drawing and the physics share them). */
export function propSpots(city: CityLayout): PropSpot[] {
  let spots = propCache.get(city);
  if (!spots) propCache.set(city, (spots = placeProps(city)));
  return spots;
}

/** The flowering trees' spots (once per layout). */
export function treeSpots(city: CityLayout): TreeSpot[] {
  let spots = treeCache.get(city);
  if (!spots) treeCache.set(city, (spots = placeTrees(city, propSpots(city))));
  return spots;
}

function placeProps(city: CityLayout): PropSpot[] {
  const out: PropSpot[] = [];
  const pavements = city.blocks.map((b) => expandBySidewalks(b, city.roads));
  const shelters = shelterSpots(city);
  // On a pavement, and clear of the bus shelters.
  const onPavement = (x: number, z: number) =>
    pavements.some((r) => inside(r, x, z)) &&
    !shelters.some((s) => Math.hypot(s.x - x, s.z - z) < SHELTER.w / 2 + 2);
  const nearJunction = (road: Road, s: number, margin: number) =>
    city.roads.some(
      (c) =>
        c.axis !== road.axis &&
        Math.abs(s - c.center) < carriageHalfWidth(c) + margin &&
        road.center >= c.from - 1 &&
        road.center <= c.to + 1,
    );
  /** A spot `off` m out from a road's centre on `side`, `s` along it, facing the road. */
  const beside = (road: Road, s: number, side: 1 | -1, off: number) => {
    const [x, z] =
      road.axis === 'ns' ? [road.center + side * off, s] : [s, road.center + side * off];
    // Facing back across the road.
    const yaw =
      road.axis === 'ns' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0;
    return { x, z, yaw };
  };

  // Hydrants: at each junction, on the west sidewalk 4 m south of the cross street's kerb
  // (clear of the corner's signal pole and sign).
  for (const j of junctions(city)) {
    const x = j.x - carriageHalfWidth(j.ns) - 0.7;
    const z = j.z + carriageHalfWidth(j.ew) + 4;
    if (onPavement(x, z)) out.push({ kind: 'hydrant', x, y: SLAB_Y, z, yaw: Math.PI / 2 });
  }

  for (const road of city.roads) {
    const kerb = carriageHalfWidth(road);
    const wide = road.sidewalk >= 4.5;
    const boulevard = road.median > 0 || road.name === 'Grand Avenue';
    for (let s = road.from + 22, k = 0; s < road.to - 22; s += 30, k += 1) {
      if (nearJunction(road, s, 12)) continue;
      const side: 1 | -1 = k % 2 === 0 ? 1 : -1;
      const [x, z] = road.axis === 'ns' ? [road.center, s] : [s, road.center];
      const district = districtAt(x, z);
      // Bins every 60 m on busy streets, by the kerb.
      if (k % 2 === 0 && BUSY.has(district)) {
        const p = beside(road, s, side, kerb + 0.9);
        if (onPavement(p.x, p.z)) out.push({ kind: 'bin', ...p, y: SLAB_Y });
      }
      // Benches facing the boulevards (and Grand Avenue), planters either side of them
      // downtown.
      if (boulevard && wide && k % 2 === 1) {
        const p = beside(road, s, side, kerb + 1.6);
        if (!onPavement(p.x, p.z)) continue;
        out.push({ kind: 'bench', ...p, y: SLAB_Y });
        if (district === 'downtown') {
          for (const d of [-2.6, 2.6]) {
            const q = beside(road, s + d, side, kerb + 1.6);
            out.push({ kind: 'planter', ...q, y: SLAB_Y });
          }
        }
      }
    }
  }

  // Parks (blocks nobody built on): benches round the edge, facing in.
  const built = new Set<Rect>();
  for (const b of city.buildings) {
    const block = city.blocks.find((r) => inside(r, b.x, b.z));
    if (block) built.add(block);
  }
  for (const block of city.blocks) {
    if (built.has(block) || block === city.plaza || block === city.landmarks.stadium.lot) continue;
    const [cx, cz] = [(block.x0 + block.x1) / 2, (block.z0 + block.z1) / 2];
    for (const t of [-0.25, 0.25]) {
      const w = block.x1 - block.x0;
      const d = block.z1 - block.z0;
      out.push({ kind: 'bench', x: cx + t * w, y: SLAB_Y, z: block.z0 + 3, yaw: 0 });
      out.push({ kind: 'bench', x: cx + t * w, y: SLAB_Y, z: block.z1 - 3, yaw: Math.PI });
      out.push({ kind: 'bench', x: block.x0 + 3, y: SLAB_Y, z: cz + t * d, yaw: Math.PI / 2 });
      out.push({ kind: 'bench', x: block.x1 - 3, y: SLAB_Y, z: cz + t * d, yaw: -Math.PI / 2 });
    }
  }

  // Concrete barriers across the end of any street that stops dead (no junction, no hill
  // road carrying on).
  const continues = (x: number, z: number) =>
    city.hillRoads.some((h) =>
      [h.points[0], h.points[h.points.length - 1]].some(
        (p) => p && Math.hypot(p.x - x, p.z - z) < 1,
      ),
    );
  for (const road of city.roads) {
    for (const [end, dir] of [
      [road.from, -1],
      [road.to, 1],
    ] as const) {
      if (nearJunction(road, end, 2)) continue;
      // Another stretch of the same street carrying straight on (split at a corridor).
      if (
        city.roads.some(
          (r) =>
            r !== road &&
            r.axis === road.axis &&
            r.center === road.center &&
            (r.from === end || r.to === end),
        )
      )
        continue;
      const [ex, ez] = road.axis === 'ns' ? [road.center, end] : [end, road.center];
      if (continues(ex, ez)) continue;
      const kerb = carriageHalfWidth(road);
      for (let c = -kerb + 0.9; c <= kerb - 0.9 + 1e-6; c += 1.8) {
        const s = end - dir * 1.2;
        const [x, z] = road.axis === 'ns' ? [road.center + c, s] : [s, road.center + c];
        out.push({ kind: 'barrier', x, y: 0, z, yaw: road.axis === 'ns' ? 0 : Math.PI / 2 });
      }
    }
  }
  return out;
}

/** A flowering tree: a jacaranda (purple) or a white-blossom tree. */
export interface TreeSpot {
  species: 'jacaranda' | 'blossom';
  x: number;
  y: number;
  z: number;
  /** Overall size (1 = a mature street tree, about 9 m tall and wide) and a seed. */
  size: number;
  seed: number;
}

const LEAFY = new Set<District>(['mid_city', 'south_grid', 'eastside', 'beach', 'palm_heights']);
/** Street trees: spacing along each side, and from the kerb into the sidewalk (m). */
const TREE_STEP = 30;
const TREE_KERB = 1.3;

/**
 * Flowering trees: along the residential streets (one species a street, as cities plant
 * them; every 30 m on each side, staggered, halfway between the street lights), groves in the
 * parks, and one or two in each hill villa's garden.
 */
function placeTrees(city: CityLayout, props: readonly PropSpot[]): TreeSpot[] {
  const out: TreeSpot[] = [];
  const pavements = city.blocks.map((b) => expandBySidewalks(b, city.roads));
  const shelters = shelterSpots(city);
  const clear = (x: number, z: number) =>
    !props.some((p) => Math.abs(p.x - x) < 2.5 && Math.abs(p.z - z) < 2.5) &&
    !shelters.some((sh) => Math.hypot(sh.x - x, sh.z - z) < SHELTER.w / 2 + 3);
  for (const road of city.roads) {
    if (road.median > 0 || road.lanesPerDir > 2) continue;
    const r = rng(hash2(0x7ee5, road.id));
    const species = r.chance(0.6) ? 'jacaranda' : 'blossom';
    const off = carriageHalfWidth(road) + TREE_KERB;
    for (const side of [-1, 1] as const) {
      // Street lights stand at 15 m and every 30 m on one side, 30 m on the other: trees fall
      // halfway between them.
      for (let s = road.from + (side < 0 ? 7.5 : 22.5); s < road.to - 7.5; s += TREE_STEP) {
        const nearJunction = city.roads.some(
          (c) =>
            c.axis !== road.axis &&
            Math.abs(s - c.center) < carriageHalfWidth(c) + 10 &&
            road.center >= c.from - 1 &&
            road.center <= c.to + 1,
        );
        if (nearJunction) continue;
        const [x, z] =
          road.axis === 'ns' ? [road.center + side * off, s] : [s, road.center + side * off];
        if (!LEAFY.has(districtAt(x, z)) || !clear(x, z)) continue;
        if (!pavements.some((b) => inside(b, x, z))) continue;
        out.push({ species, x, y: SLAB_Y, z, size: r.range(0.85, 1.1), seed: r.int(0, 1 << 30) });
      }
    }
  }

  // Parks: a grove of five, kept off the benches round the edge.
  const built = new Set<Rect>();
  for (const b of city.buildings) {
    const block = city.blocks.find((q) => inside(q, b.x, b.z));
    if (block) built.add(block);
  }
  for (const block of city.blocks) {
    if (built.has(block) || block === city.plaza || block === city.landmarks.stadium.lot) continue;
    const r = rng(hash2(0x9a7c, Math.round(block.x0 * 7 + block.z0)));
    for (let i = 0; i < 5; i += 1) {
      const x = r.range(block.x0 + 10, block.x1 - 10);
      const z = r.range(block.z0 + 10, block.z1 - 10);
      if (out.some((t) => Math.hypot(t.x - x, t.z - z) < 8)) continue;
      out.push({
        species: r.chance(0.5) ? 'jacaranda' : 'blossom',
        x,
        y: SLAB_Y,
        z,
        size: r.range(0.9, 1.25),
        seed: r.int(0, 1 << 30),
      });
    }
  }

  // Hill villas: one or two in the garden, beside the house.
  for (const v of city.buildings) {
    if (!v.drive) continue;
    const r = rng(v.seed ^ 0x3ee);
    for (const side of r.chance(0.5) ? [-1, 1] : [r.chance(0.5) ? -1 : 1]) {
      const x = v.x + side * (v.w / 2 + 3);
      const z = v.z + r.range(-v.d / 4, v.d / 4);
      out.push({
        species: r.chance(0.55) ? 'jacaranda' : 'blossom',
        x,
        y: terrainHeight(x, z),
        z,
        size: r.range(0.8, 1.05),
        seed: r.int(0, 1 << 30),
      });
    }
  }
  return out;
}

/** A flower bed: soil over a rectangle at height y. */
export interface Bed {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
}

/** A clump of flowers (`mix`: which planting, gardens.ts) or an agave. */
export interface PlantSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  size: number;
  mix: number;
}

/** How many plantings there are (gardens.ts draws one colour each). */
const PLANTINGS = 6;

export interface Gardens {
  beds: Bed[];
  flowers: PlantSpot[];
  agaves: PlantSpot[];
}

const gardenCache = new WeakMap<CityLayout, Gardens>();

/** Flower beds, their flowers, and agaves (once per layout). */
export function gardens(city: CityLayout): Gardens {
  let g = gardenCache.get(city);
  if (!g) gardenCache.set(city, (g = placeGardens(city)));
  return g;
}

/**
 * Gardens: flower beds at the front corners of every house and villa (clear of the door and
 * the garage), round a bed in the middle of each park and along the plaza's lawns where they
 * meet the paths; flowers in the street planters; agaves round the villas and the parks'
 * beds.
 */
function placeGardens(city: CityLayout): Gardens {
  const beds: Bed[] = [];
  const flowers: PlantSpot[] = [];
  const agaves: PlantSpot[] = [];
  /**
   * Fills a bed with clumps about `step` m apart, jittered, in two colours: rows of one along
   * its long side, the rest the other (as bedding is planted).
   */
  const fill = (bed: Bed, r: ReturnType<typeof rng>, step = 0.55) => {
    beds.push(bed);
    const a = r.int(0, PLANTINGS - 1);
    const b = (a + r.int(1, PLANTINGS - 1)) % PLANTINGS;
    const alongX = bed.x1 - bed.x0 >= bed.z1 - bed.z0;
    for (let x = bed.x0 + step / 2; x < bed.x1; x += step) {
      for (let z = bed.z0 + step / 2; z < bed.z1; z += step) {
        const row = Math.floor(((alongX ? z - bed.z0 : x - bed.x0) / step) % 2);
        flowers.push({
          x: x + r.range(-0.12, 0.12),
          y: bed.y,
          z: z + r.range(-0.12, 0.12),
          yaw: r.range(0, Math.PI * 2),
          size: r.range(0.85, 1.2),
          mix: row === 0 ? a : b,
        });
      }
    }
  };

  for (const b of city.buildings) {
    if (b.style !== 'house' && b.style !== 'villa') continue;
    // The front: a hill villa faces its road; a house the nearer street of its block.
    let north: boolean;
    if (b.drive) north = b.drive.north;
    else {
      const block = city.blocks.find((q) => inside(q, b.x, b.z));
      if (!block) continue;
      north = b.z - b.d / 2 - block.z0 <= block.z1 - (b.z + b.d / 2);
    }
    const r = rng(b.seed ^ 0xf10e);
    const y = (b.y ?? 0) + SLAB_Y + 0.01;
    const wall = north ? b.z - b.d / 2 : b.z + b.d / 2;
    const [z0, z1] = north ? [wall - 1.1, wall - 0.1] : [wall + 0.1, wall + 1.1];
    const width = b.style === 'villa' ? Math.min(3.2, b.w * 0.18) : Math.min(1.8, b.w * 0.14);
    fill({ x0: b.x - b.w / 2 + 0.2, z0, x1: b.x - b.w / 2 + 0.2 + width, z1, y }, r);
    fill({ x0: b.x + b.w / 2 - 0.2 - width, z0, x1: b.x + b.w / 2 - 0.2, z1, y }, r);
    // Agaves round a villa's garden, beside the house (a house's front yard has no room).
    if (!b.drive) continue;
    for (let i = r.int(3, 5); i > 0; i -= 1) {
      const side = i % 2 === 0 ? -1 : 1;
      const x = b.x + side * (b.w / 2 + r.range(0.8, 2.2));
      const z = b.z + r.range(-b.d / 2, b.d / 2);
      agaves.push({
        x,
        y: terrainHeight(x, z),
        z,
        yaw: r.range(0, 6.3),
        size: r.range(1.3, 1.9),
        mix: 0,
      });
    }
  }

  // Parks: a round bed in the middle, agaves round it.
  const built = new Set<Rect>();
  for (const b of city.buildings) {
    const block = city.blocks.find((q) => inside(q, b.x, b.z));
    if (block) built.add(block);
  }
  for (const block of city.blocks) {
    if (built.has(block) || block === city.plaza || block === city.landmarks.stadium.lot) continue;
    const r = rng(hash2(0xf1a, Math.round(block.x0 * 3 + block.z0)));
    const [cx, cz] = [(block.x0 + block.x1) / 2, (block.z0 + block.z1) / 2];
    const [ma, mb] = [r.int(0, PLANTINGS - 1), r.int(0, PLANTINGS - 1)];
    beds.push({ x0: cx - 3.6, z0: cz - 3.6, x1: cx + 3.6, z1: cz + 3.6, y: SLAB_Y + 0.01 });
    for (let ring = 0.6; ring < 3.6; ring += 0.6) {
      const n = Math.round((Math.PI * 2 * ring) / 0.6);
      for (let k = 0; k < n; k += 1) {
        const a = (k / n) * Math.PI * 2;
        flowers.push({
          x: cx + Math.cos(a) * ring,
          y: SLAB_Y + 0.01,
          z: cz + Math.sin(a) * ring,
          yaw: a,
          size: r.range(0.85, 1.2),
          // Rings of two colours.
          mix: Math.round(ring / 0.6) % 2 === 0 ? ma : mb,
        });
      }
    }
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      agaves.push({
        x: cx + Math.cos(a) * 5.2,
        y: SLAB_Y,
        z: cz + Math.sin(a) * 5.2,
        yaw: a,
        size: r.range(1.5, 2),
        mix: 0,
      });
    }
  }

  // The plaza: beds along each lawn where it meets the paths (clear of the fountain).
  {
    const p = city.plaza;
    const [cx, cz] = [(p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2];
    const r = rng(0x91a2f);
    const y = SLAB_Y + 0.012;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        // The lawn's edges on the path along x and the path along z.
        const ex = cx + sx * 5;
        const ez = cz + sz * 5;
        const far = { x: sx < 0 ? p.x0 + 4 : p.x1 - 4, z: sz < 0 ? p.z0 + 4 : p.z1 - 4 };
        const start = 12;
        fill(
          {
            x0: Math.min(ex + sx * start, far.x),
            z0: Math.min(ez, ez + sz * 1.4),
            x1: Math.max(ex + sx * start, far.x),
            z1: Math.max(ez, ez + sz * 1.4),
            y,
          },
          r,
        );
        fill(
          {
            x0: Math.min(ex, ex + sx * 1.4),
            z0: Math.min(ez + sz * start, far.z),
            x1: Math.max(ex, ex + sx * 1.4),
            z1: Math.max(ez + sz * start, far.z),
            y,
          },
          r,
        );
      }
    }
  }

  // Flowers in the street planters (their soil 0.6 m up).
  for (const s of propSpots(city)) {
    if (s.kind !== 'planter') continue;
    const r = rng(hash2(Math.round(s.x * 10), Math.round(s.z * 10)));
    const mix = r.int(0, PLANTINGS - 1);
    for (const along of [-0.42, 0, 0.42]) {
      flowers.push({
        x: s.x + Math.cos(s.yaw) * along,
        y: s.y + 0.6,
        z: s.z - Math.sin(s.yaw) * along,
        yaw: r.range(0, 6.3),
        size: 0.75,
        mix,
      });
    }
  }
  return { beds, flowers, agaves };
}
