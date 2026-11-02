/**
 * The residential art pass (Phase 2): what makes a house read as a home rather than a small
 * office block. For every house and villa: a pitched roof (terracotta barrel tiles mostly,
 * shingles for some), stucco gable ends in the wall's colour, a front door and often a garage
 * facing the street, a driveway and a front path to the sidewalk; lawns over residential
 * blocks and hedges along their street edges, broken where the paths and driveways cross.
 * Villas get hip roofs or flat modern roofs with parapets; hill villas stand on their pads
 * (villas.ts) with a drive laid down to the road and often a pool behind. Empty blocks become
 * parks. Walls themselves are still drawn
 * by the facade shader in city.ts; nothing here collides (roofs sit above the walls).
 */
import { type Building, type CityLayout, type Rect, rng, terrainHeight } from '@fr33world/city';
import * as THREE from 'three';
import { surfaceMaterial, surfaceSet, type Textures } from '../materials.ts';
import { GeoBuilder } from './geo.ts';
import { TINTS } from './palette.ts';
import { BIG_TILE, TiledGeo } from './tiles.ts';

/** The sidewalk slab height (city.ts SLAB_Y; repeated to avoid a cycle). */
const SLAB_Y = 0.15;
const OVERHANG = 0.45;
/** Roof tile texture repeat (m). */
const ROOF_TILE = 2.2;

type V = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Adds a flat polygon (3 or 4 points), wound to face `outward`. */
function face(g: GeoBuilder, pts: V[], uvs: number[], outward: V) {
  const [a, b, c] = pts as [V, V, V];
  const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  let p = pts;
  let uv = uvs;
  if (n.dot(outward) < 0) {
    p = [...pts].reverse();
    const pairs: number[][] = [];
    for (let i = 0; i < uvs.length; i += 2) pairs.push([uvs[i] as number, uvs[i + 1] as number]);
    uv = pairs.reverse().flat();
    n.negate();
  }
  if (p.length === 3)
    g.tri(
      p[0] as V,
      p[1] as V,
      p[2] as V,
      n,
      uv as [number, number, number, number, number, number],
    );
  else
    g.quad(
      p[0] as V,
      p[1] as V,
      p[2] as V,
      p[3] as V,
      n,
      uv as [number, number, number, number, number, number, number, number],
    );
}

/** Box edges: ridge runs along the longer side. `a` = along the ridge, `c` = across it. */
interface Footprint {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * A gable roof: two slopes up to a ridge along the longer side, eaves overhanging, and the
 * triangular gable walls at both ends (in `wall`).
 */
function gableRoof(roof: GeoBuilder, wall: GeoBuilder, f: Footprint, top: number, pitch: number) {
  const alongX = f.x1 - f.x0 >= f.z1 - f.z0;
  const span = alongX ? f.z1 - f.z0 : f.x1 - f.x0;
  const rise = (span / 2) * pitch;
  const drop = OVERHANG * pitch;
  const ridge = top + rise;
  const eave = top - drop;
  // Work in (a, c): a along the ridge, c across it; map back to x/z.
  const P = (a: number, y: number, c: number) => (alongX ? v(a, y, c) : v(c, y, a));
  const [a0, a1] = alongX ? [f.x0, f.x1] : [f.z0, f.z1];
  const [c0, c1] = alongX ? [f.z0, f.z1] : [f.x0, f.x1];
  const cm = (c0 + c1) / 2;
  const slope = Math.hypot(span / 2 + OVERHANG, rise + drop);
  const L = (a1 - a0 + 2 * OVERHANG) / ROOF_TILE;
  const S = slope / ROOF_TILE;
  for (const [ce, out] of [
    [c0 - OVERHANG, -1],
    [c1 + OVERHANG, 1],
  ] as const) {
    const outward = alongX ? v(0, 1, out) : v(out, 1, 0);
    face(
      roof,
      [
        P(a0 - OVERHANG, eave, ce),
        P(a1 + OVERHANG, eave, ce),
        P(a1 + OVERHANG, ridge, cm),
        P(a0 - OVERHANG, ridge, cm),
      ],
      [0, 0, L, 0, L, S, 0, S],
      outward,
    );
  }
  for (const [a, out] of [
    [a0, -1],
    [a1, 1],
  ] as const) {
    const outward = alongX ? v(out, 0, 0) : v(0, 0, out);
    face(wall, [P(a, top, c0), P(a, top, c1), P(a, ridge, cm)], [0, 0, 1, 0, 0.5, 1], outward);
  }
}

/** A hip roof: four slopes, the ridge shortened by half the span at each end. */
function hipRoof(roof: GeoBuilder, f: Footprint, top: number, pitch: number) {
  const alongX = f.x1 - f.x0 >= f.z1 - f.z0;
  const span = alongX ? f.z1 - f.z0 : f.x1 - f.x0;
  const rise = (span / 2) * pitch;
  const drop = OVERHANG * pitch;
  const P = (a: number, y: number, c: number) => (alongX ? v(a, y, c) : v(c, y, a));
  const [a0, a1] = alongX ? [f.x0 - OVERHANG, f.x1 + OVERHANG] : [f.z0 - OVERHANG, f.z1 + OVERHANG];
  const [c0, c1] = alongX ? [f.z0 - OVERHANG, f.z1 + OVERHANG] : [f.x0 - OVERHANG, f.x1 + OVERHANG];
  const cm = (c0 + c1) / 2;
  const half = (c1 - c0) / 2;
  const r0 = Math.min(a0 + half, (a0 + a1) / 2);
  const r1 = Math.max(a1 - half, (a0 + a1) / 2);
  const eave = top - drop;
  const ridge = top + rise;
  const L = (a1 - a0) / ROOF_TILE;
  const S = Math.hypot(half, rise + drop) / ROOF_TILE;
  const up = (x: number, z: number) => (alongX ? v(x, 1, z) : v(z, 1, x));
  face(
    roof,
    [P(a0, eave, c0), P(a1, eave, c0), P(r1, ridge, cm), P(r0, ridge, cm)],
    [0, 0, L, 0, L * 0.75, S, L * 0.25, S],
    up(0, -1),
  );
  face(
    roof,
    [P(a1, eave, c1), P(a0, eave, c1), P(r0, ridge, cm), P(r1, ridge, cm)],
    [0, 0, L, 0, L * 0.75, S, L * 0.25, S],
    up(0, 1),
  );
  face(
    roof,
    [P(a0, eave, c1), P(a0, eave, c0), P(r0, ridge, cm)],
    [0, 0, S * 1.6, 0, S * 0.8, S],
    up(-1, 0),
  );
  face(
    roof,
    [P(a1, eave, c0), P(a1, eave, c1), P(r1, ridge, cm)],
    [0, 0, S * 1.6, 0, S * 0.8, S],
    up(1, 0),
  );
}

/**
 * A strip from z0 to z1 between x0 and x1 laid on the terrain (`lift` m over it), in 2 m
 * pieces: a hill villa's drive down to its road.
 */
function drape(g: GeoBuilder, x0: number, z0: number, x1: number, z1: number, lift: number) {
  const n = Math.max(1, Math.ceil(Math.abs(z1 - z0) / 2));
  const up = { x: 0, y: 1, z: 0 };
  const at = (x: number, z: number) => ({ x, y: terrainHeight(x, z) + lift, z });
  const [za, zb] = z0 < z1 ? [z0, z1] : [z1, z0];
  for (let i = 0; i < n; i += 1) {
    const s0 = za + ((zb - za) * i) / n;
    const s1 = za + ((zb - za) * (i + 1)) / n;
    g.quad(at(x0, s1), at(x1, s1), at(x1, s0), at(x0, s0), up, [
      x0 / 2,
      s1 / 2,
      x1 / 2,
      s1 / 2,
      x1 / 2,
      s0 / 2,
      x0 / 2,
      s0 / 2,
    ]);
  }
}

const DOOR_COLOURS = [0x5a3a24, 0x2f6f73, 0x8c2f2a, 0x24344d, 0xe8e4da, 0x3d4a35];
const GARAGE_COLOURS = [0xe9e6df, 0xd8d4cb, 0xb9b3a8];

/** The block a building stands in, and which way its front faces (toward the nearer street). */
function frontOf(b: Building, blocks: Rect[]): { block: Rect; north: boolean } | null {
  const block = blocks.find((r) => b.x >= r.x0 && b.x <= r.x1 && b.z >= r.z0 && b.z <= r.z1);
  if (!block) return null;
  const toNorth = b.z - b.d / 2 - block.z0;
  const toSouth = block.z1 - (b.z + b.d / 2);
  return { block, north: toNorth <= toSouth };
}

/**
 * Returns tile groups (tiles.ts): roofs, gables and lawns are drawn out to `far`, doors,
 * driveways and hedges only within `near`.
 */
export function buildHomes(
  city: CityLayout,
  textures: Textures,
  distance: { far: number; near: number },
): THREE.Group[] {
  const homes = city.buildings.filter((b) => b.style === 'house' || b.style === 'villa');
  if (homes.length === 0) return [];
  const big = new TiledGeo(
    () => ({
      clay: new GeoBuilder(),
      shingle: new GeoBuilder(),
      gables: new GeoBuilder().attribute('color', 3, [1, 1, 1]),
      lawn: new GeoBuilder(),
    }),
    BIG_TILE,
  );
  const details = new TiledGeo(() => ({
    painted: new GeoBuilder().attribute('color', 3, [1, 1, 1]),
    paving: new GeoBuilder(),
    hedge: new GeoBuilder(),
    water: new GeoBuilder(),
  }));
  /** Gaps in each block's street-edge hedge (driveways and paths), by block and side. */
  const gaps = new Map<Rect, { north: [number, number][]; south: [number, number][] }>();
  const residential = new Set<Rect>();
  const colour = new THREE.Color();

  for (const b of homes) {
    // In a city block, facing its nearer street; a hill villa faces its road.
    const front = b.drive ? null : frontOf(b, city.blocks);
    if (!b.drive && !front) continue;
    const north = b.drive?.north ?? (front as { north: boolean }).north;
    const block = front?.block ?? null;
    const blockGaps = { north: [] as [number, number][], south: [] as [number, number][] };
    if (block) {
      residential.add(block);
      gaps.set(block, gaps.get(block) ?? blockGaps);
    }
    const { clay, shingle, gables } = big.at(b.x, b.z);
    const { painted, paving, water } = details.at(b.x, b.z);
    const r = rng(b.seed);
    // The wall colour city.ts picked first from the same seed, for the gable ends.
    const wallTint = r.pick(TINTS.stucco);
    const base = SLAB_Y + (b.y ?? 0);
    const top = base + b.h;
    const x0 = b.x - b.w / 2;
    const x1 = b.x + b.w / 2;
    const z0 = b.z - b.d / 2;
    const z1 = b.z + b.d / 2;
    const roofs = r.chance(0.72) ? clay : shingle;

    if (b.style === 'house') {
      gables.set('color', colour.setHex(wallTint).toArray());
      gableRoof(roofs, gables, { x0, x1, z0, z1 }, top, r.range(0.35, 0.55));
    } else {
      // Villas: the upper floor (inset as in city.ts) carries the roof.
      const inset = Math.min(b.w, b.d) * 0.18;
      const up = { x0: x0 + inset, x1: x1 - inset, z0: z0 + inset, z1: z1 - inset };
      if (r.chance(0.55)) {
        hipRoof(roofs, up, top, r.range(0.3, 0.42));
      } else {
        // Modern flat roof: parapets round the upper floor and the ground-floor terrace.
        painted.set('color', colour.setHex(0xf2efe8).toArray());
        const p = 0.25;
        for (const [fx0, fx1, fz0, fz1, y] of [
          [up.x0, up.x1, up.z0, up.z1, top],
          [x0, x1, z0, z1, base + b.floorHeight],
        ] as const) {
          painted.box(fx0, y, fz0, fx1, y + 0.7, fz0 + p, 1);
          painted.box(fx0, y, fz1 - p, fx1, y + 0.7, fz1, 1);
          painted.box(fx0, y, fz0 + p, fx0 + p, y + 0.7, fz1 - p, 1);
          painted.box(fx1 - p, y, fz0 + p, fx1, y + 0.7, fz1 - p, 1);
        }
      }
    }

    // The street side: door, maybe a garage, a path and a driveway down to the sidewalk (on
    // the hills, down to the road, laid on the ground).
    const wallZ = north ? z0 : z1;
    const out = north ? -1 : 1;
    const garage = b.w >= 11 && r.chance(0.7);
    const doorX = garage ? b.x - b.w * 0.22 : b.x + r.range(-1, 1);
    const garageX = b.x + b.w * 0.24;
    const skin = 0.04 * out;
    painted.set('color', colour.setHex(r.pick(DOOR_COLOURS)).toArray());
    painted.box(
      doorX - 0.5,
      base,
      wallZ + Math.min(0, skin),
      doorX + 0.5,
      base + 2.2,
      wallZ + Math.max(0, skin),
      1,
    );
    // A step and a small canopy over the door.
    painted.set('color', colour.setHex(0xcfc8bb).toArray());
    painted.box(
      doorX - 0.9,
      base,
      wallZ + Math.min(0, out * 1.1),
      doorX + 0.9,
      base + 0.15,
      wallZ + Math.max(0, out * 1.1),
      1,
    );
    painted.box(
      doorX - 1,
      base + 2.55,
      wallZ + Math.min(0, out * 1.2),
      doorX + 1,
      base + 2.7,
      wallZ + Math.max(0, out * 1.2),
      1,
    );
    const lanes: [number, number][] = [[doorX - 0.6, doorX + 0.6]];
    if (garage) {
      painted.set('color', colour.setHex(r.pick(GARAGE_COLOURS)).toArray());
      painted.box(
        garageX - 1.35,
        base,
        wallZ + Math.min(0, skin),
        garageX + 1.35,
        base + 2.3,
        wallZ + Math.max(0, skin),
        1,
      );
      lanes.push([garageX - 1.6, garageX + 1.6]);
    }
    for (const [lx0, lx1] of lanes) {
      if (block) {
        const edgeZ = north ? block.z0 : block.z1;
        paving.flat(lx0, Math.min(wallZ, edgeZ), lx1, Math.max(wallZ, edgeZ), SLAB_Y + 0.006, 2);
        (gaps.get(block)?.[north ? 'north' : 'south'] ?? []).push([lx0 - 0.3, lx1 + 0.3]);
      } else if (b.drive) {
        drape(paving, lx0, wallZ, lx1, b.drive.toZ, 0.03);
      }
    }
    // Hill villas: often a pool in the back garden, in a pale stone surround.
    if (b.drive && r.chance(0.65)) {
      const back = north ? z1 : z0;
      const pw = Math.min(b.w - 4, r.range(7, 11));
      const px = b.x + r.range(-1, 1) * (b.w - pw - 2) * 0.5;
      const [pz0, pz1] = north ? [back + 1.8, back + 5.8] : [back - 5.8, back - 1.8];
      painted.set('color', colour.setHex(0xd9d2c3).toArray());
      painted.box(px - pw / 2 - 1, base - 0.15, pz0 - 1, px + pw / 2 + 1, base + 0.02, pz1 + 1, 1);
      water.flat(px - pw / 2, pz0, px + pw / 2, pz1, base + 0.04, 2);
    }
  }

  // Blocks nobody built on are parks (grass), not bare concrete.
  const built = new Set<Rect>();
  for (const b of city.buildings) {
    const block = city.blocks.find((r) => b.x >= r.x0 && b.x <= r.x1 && b.z >= r.z0 && b.z <= r.z1);
    if (block) built.add(block);
  }
  for (const block of city.blocks) {
    // (The stadium's lot is its parking.)
    if (block === city.plaza || block === city.landmarks.stadium.lot || built.has(block)) continue;
    big
      .at((block.x0 + block.x1) / 2, (block.z0 + block.z1) / 2)
      .lawn.flat(block.x0, block.z0, block.x1, block.z1, SLAB_Y + 0.003, 3);
  }

  // Lawns over residential blocks, and hedges along their street edges.
  for (const block of residential) {
    const cx = (block.x0 + block.x1) / 2;
    const cz = (block.z0 + block.z1) / 2;
    big.at(cx, cz).lawn.flat(block.x0, block.z0, block.x1, block.z1, SLAB_Y + 0.003, 3);
    const { hedge } = details.at(cx, cz);
    const g = gaps.get(block);
    for (const [edgeZ, side] of [
      [block.z0 + 0.6, g?.north ?? []],
      [block.z1 - 0.6, g?.south ?? []],
    ] as const) {
      const cuts = [...side].sort((a, b) => a[0] - b[0]);
      let x = block.x0 + 0.6;
      for (const [c0, c1] of [...cuts, [block.x1 - 0.6, Infinity] as [number, number]]) {
        if (c0 - x > 1.5)
          hedge.box(
            x,
            SLAB_Y,
            edgeZ - 0.3,
            Math.min(c0, block.x1 - 0.6),
            SLAB_Y + 0.9,
            edgeZ + 0.3,
            1.5,
          );
        x = Math.max(x, c1);
      }
    }
  }

  const roofMaterial = (set: string, tint: number) =>
    surfaceMaterial(surfaceSet(textures, set), { tint, normalScale: 1.4 });
  const plain = (opts: THREE.MeshStandardMaterialParameters) =>
    new THREE.MeshStandardMaterial(opts);
  const grass = surfaceSet(textures, 'grass');
  return [
    big.build(
      {
        clay: { material: roofMaterial('roof_clay', 0xffffff), name: 'roofs-clay', cast: true },
        shingle: {
          material: roofMaterial('roof_shingle', 0xd6d2cc),
          name: 'roofs-shingle',
          cast: true,
        },
        gables: {
          material: plain({ vertexColors: true, roughness: 0.9 }),
          name: 'gables',
          cast: true,
        },
        lawn: {
          material: surfaceMaterial(grass, { tint: 0x86a84e, matte: true, overlay: 1 }),
          name: 'lawns',
        },
      },
      distance.far,
      'homes',
    ),
    details.build(
      {
        painted: {
          material: plain({ vertexColors: true, roughness: 0.6 }),
          name: 'doors-and-trims',
          cast: true,
        },
        paving: {
          material: plain({
            color: 0xbdb7ad,
            roughness: 0.95,
            polygonOffset: true,
            polygonOffsetFactor: -2,
          }),
          name: 'driveways',
        },
        hedge: {
          material: surfaceMaterial(grass, { tint: 0x4d6b34, matte: true }),
          name: 'hedges',
          cast: true,
        },
        water: {
          material: plain({
            color: 0x3fa7c4,
            roughness: 0.05,
            metalness: 0.1,
            polygonOffset: true,
            polygonOffsetFactor: -3,
          }),
          name: 'pools',
        },
      },
      distance.near,
      'home-details',
    ),
  ];
}
