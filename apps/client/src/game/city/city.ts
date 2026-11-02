/**
 * Builds the visible Los Soles block from the shared layout (@fr33world/city): the same data
 * the world server validates movement against. Each layer is merged into one mesh per
 * material, so the whole block is a few dozen draw calls.
 */
import {
  barrierGaps,
  type Building,
  type CityLayout,
  carriageHalfWidth,
  COAST,
  HARBOUR,
  landOutline,
  type Rect,
  RIVER,
  type Road,
  rng,
  roadHalfWidth,
  terrainHeight,
  QUARRY,
} from '@fr33world/city';
import * as THREE from 'three';
import {
  facadeMaterial,
  type FacadeKind,
  surfaceMaterial,
  surfaceSet,
  type Textures,
} from '../materials.ts';
import type { Quality } from '../quality.ts';
import { GeoBuilder } from './geo.ts';
import { buildHomes } from './homes.ts';
import { buildStorefronts } from './storefronts.ts';
import { BAY, TINTS } from './palette.ts';
import { buildBridges } from './bridges.ts';
import { buildFlyovers } from './flyovers.ts';
import { buildHillRoads } from './hillroads.ts';
import { buildTerrain } from './ground.ts';
import { buildLandmarks } from './landmarks.ts';
import { buildPalms } from './palms.ts';
import { buildGardens } from './gardens.ts';
import { buildHillCover } from './hillscrub.ts';
import { gardens as gardenSpots, treeSpots } from './placements.ts';
import { buildProps } from './props.ts';
import { buildTrees } from './trees.ts';
import { buildShelters } from './shelters.ts';
import { buildJobSites } from './jobsites.ts';
import { buildDealership } from './dealership.ts';
import { buildParking } from './parking.ts';
import { buildServices } from './services.ts';
import { buildKiosks } from './kiosk.ts';
import { buildSignals } from './signals.ts';
import { buildStreetLights } from './streetlights.ts';
import { BIG_TILE, DETAIL_DISTANCE, TiledGeo, updateTiles } from './tiles.ts';

export const SLAB_Y = 0.15;
const MARK_Y = 0.012;

export interface CityView {
  group: THREE.Group;
  /**
   * Per frame: lamps and lit windows follow the night factor, traffic signals the clock; palm,
   * lamp and signal tiles beyond the tier's draw distance from `eye` are hidden.
   */
  update(night: number, eye: THREE.Vector3): void;
}

export function buildCity(city: CityLayout, textures: Textures, quality: Quality): CityView {
  const group = new THREE.Group();
  group.name = 'city';

  const road = surfaceMaterial(surfaceSet(textures, 'road'), { tint: 0x5e5b58 });
  const sidewalk = surfaceMaterial(surfaceSet(textures, 'sidewalk'), { tint: 0xc9c1b4 });
  const concrete = surfaceMaterial(surfaceSet(textures, 'sidewalk'), { tint: 0x9d978d });
  const grass = surfaceMaterial(surfaceSet(textures, 'grass'), { tint: 0x86a84e, matte: true });
  const paving = surfaceMaterial(surfaceSet(textures, 'sidewalk'), { tint: 0xdcc9ac, overlay: 1 });
  const plazaLawn = surfaceMaterial(surfaceSet(textures, 'grass'), {
    tint: 0x86a84e,
    matte: true,
    overlay: 2,
  });

  /** Tile groups whose draw distance follows the camera (tiles.ts). */
  const tiled: THREE.Group[] = [];
  const far = quality.viewDistance;
  const near = DETAIL_DISTANCE[quality.tier];

  // ---- ground: sea, land, beach, hills, river; then roads, markings, sidewalks -------------
  buildGround(group, concrete);
  // The quarry's floor: dusty gravel, not the city's concrete (the terrain leaves flat ground out).
  const quarryFloor = surfaceMaterial(surfaceSet(textures, 'hill_dirt'), {
    tint: 0xb8a68c,
    matte: true,
    overlay: 2,
  });
  addMesh(
    group,
    new GeoBuilder()
      .flat(QUARRY.x0 - 60, QUARRY.z0 - 60, QUARRY.x1 + 60, QUARRY.z1 + 60, 0.004, 6)
      .build(),
    quarryFloor,
    { receive: true, name: 'quarry-floor' },
  );
  const terrain = buildTerrain(quality, textures);
  tiled.push(terrain);

  const streets = new TiledGeo(
    () => ({
      roads: new GeoBuilder(),
      sidewalks: new GeoBuilder(),
      curbs: new GeoBuilder(),
      medians: new GeoBuilder(),
    }),
    BIG_TILE,
  );
  for (const r of city.roads) {
    const half = carriageHalfWidth(r);
    streets.split(r.from, r.to, (a0, a1) => {
      const mid = (a0 + a1) / 2;
      if (r.axis === 'ns')
        streets.at(r.center, mid).roads.flat(r.center - half, a0, r.center + half, a1, 0, 8);
      else streets.at(mid, r.center).roads.flat(a0, r.center - half, a1, r.center + half, 0, 8);
    });
  }

  const markings = new TiledGeo(() => ({ white: new GeoBuilder(), yellow: new GeoBuilder() }));
  buildMarkings(city, markings);
  const paint = (color: number) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.75,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  tiled.push(
    markings.build(
      {
        white: { material: paint(0xe9e6df), name: 'paint-white' },
        yellow: { material: paint(0xd9a623), name: 'paint-yellow' },
      },
      near,
      'markings',
    ),
  );

  for (const block of city.blocks) {
    const r = expandBySidewalks(block, city.roads);
    streets
      .at((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2)
      .sidewalks.box(r.x0, -0.02, r.z0, r.x1, SLAB_Y, r.z1, 3);
  }

  // Planted median on the boulevard, between junctions.
  for (const r of city.roads) {
    if (r.median === 0) continue;
    for (const [s0, s1] of segmentsBetweenJunctions(r, city.roads)) {
      const m = r.median / 2;
      const mid = (s0 + s1) / 2;
      if (r.axis === 'ns') {
        const t = streets.at(r.center, mid);
        t.curbs.box(r.center - m, -0.02, s0 + 1.5, r.center + m, 0.2, s1 - 1.5, 3, false);
        t.medians.flat(r.center - m, s0 + 1.5, r.center + m, s1 - 1.5, 0.2, 4);
      } else {
        const t = streets.at(mid, r.center);
        t.curbs.box(s0 + 1.5, -0.02, r.center - m, s1 - 1.5, 0.2, r.center + m, 3, false);
        t.medians.flat(s0 + 1.5, r.center - m, s1 - 1.5, r.center + m, 0.2, 4);
      }
    }
  }
  tiled.push(
    streets.build(
      {
        roads: { material: road, name: 'roads' },
        sidewalks: { material: sidewalk, name: 'sidewalks' },
        curbs: { material: concrete, name: 'median-curbs' },
        medians: { material: grass, name: 'median-grass' },
      },
      far,
      'streets',
    ),
  );

  buildPlaza(group, city.plaza, { paving, grass: plazaLawn, concrete });

  // ---- buildings ----------------------------------------------------------------------------
  const facades = new TiledGeo(facadeBuilders, BIG_TILE);
  for (const b of city.buildings) addBuilding(facades.at(b.x, b.z), b);
  const sets: Record<FacadeKind, string> = {
    glass: 'facade_tiles',
    tiles: 'facade_tiles',
    stucco: 'stucco',
    brick: 'brick',
    cladding: 'cladding',
  };
  const facadeSpec = (kind: FacadeKind) => ({
    material: facadeMaterial(kind, surfaceSet(textures, sets[kind]), quality),
    name: `facade-${kind}`,
    cast: true,
  });
  tiled.push(
    facades.build(
      {
        glass: facadeSpec('glass'),
        tiles: facadeSpec('tiles'),
        stucco: facadeSpec('stucco'),
        brick: facadeSpec('brick'),
        cladding: facadeSpec('cladding'),
      },
      far,
      'facades',
    ),
  );

  // The hill roads lie on the graded terrain, which draws with depth bias over the flat land:
  // they need more.
  const hillRoad = surfaceMaterial(surfaceSet(textures, 'road'), { tint: 0x5e5b58, overlay: 4 });
  const hillCurb = surfaceMaterial(surfaceSet(textures, 'sidewalk'), {
    tint: 0xa8a297,
    overlay: 4,
  });
  const rail = new THREE.MeshStandardMaterial({ color: 0xa4a9ad, roughness: 0.45, metalness: 0.7 });
  tiled.push(...buildHillRoads(city, { road: hillRoad, curb: hillCurb, rail }, far, near));

  tiled.push(...buildHomes(city, textures, { far, near }));
  const storefronts = buildStorefronts(city, near);
  tiled.push(storefronts.group);
  for (const t of tiled) group.add(t);
  buildFreeways(group, city, { road, concrete });
  group.add(buildBridges(city, { concrete, sidewalk }));
  group.add(buildFlyovers(city, { road, concrete }));
  const landmarks = buildLandmarks(city);
  group.add(landmarks.group);

  const palms = buildPalms(city.palms, textures, quality);
  group.add(palms);
  const trees = buildTrees(treeSpots(city), textures, quality);
  group.add(trees);
  const gardens = buildGardens(gardenSpots(city), quality.tier);
  group.add(gardens);
  const cover = buildHillCover(textures, quality.tier);
  group.add(cover);
  const lights = buildStreetLights(city.lights, quality.tier);
  group.add(lights.group);
  const signals = buildSignals(city, quality.tier);
  group.add(signals.group);
  const props = buildProps(city, quality.tier);
  group.add(props);
  const shelters = buildShelters(city, quality.tier);
  group.add(shelters.group);
  const kiosks = buildKiosks(city);
  group.add(kiosks.group);
  const jobSites = buildJobSites(city);
  group.add(jobSites.group);
  const services = buildServices(city);
  group.add(services.group);
  const parking = buildParking(
    city,
    surfaceMaterial(surfaceSet(textures, 'road'), { tint: 0x55524f, overlay: 3 }),
  );
  group.add(parking.group);
  const dealer = buildDealership(
    city,
    surfaceMaterial(surfaceSet(textures, 'sidewalk'), { tint: 0xe2ded6, overlay: 3 }),
  );
  group.add(dealer.group);

  // Of some 2,600 objects only the Ferris wheel moves, so the rest needn't redo their matrices
  // every frame. (The scene's own matrix stays put too, or it would force all of them: Game.)
  group.updateMatrixWorld(true);
  group.matrixAutoUpdate = false;
  for (const child of group.children) child.matrixWorldAutoUpdate = child === landmarks.group;

  return {
    group,
    update(night: number, eye: THREE.Vector3) {
      services.update(eye);
      lights.update(night);
      storefronts.update(night);
      landmarks.update(night);
      kiosks.update(night);
      jobSites.update(night);
      parking.update(night);
      dealer.update(night, eye);
      updateTiles(palms, eye);
      updateTiles(trees, eye);
      updateTiles(gardens, eye);
      updateTiles(cover, eye);
      updateTiles(lights.group, eye);
      updateTiles(signals.group, eye);
      updateTiles(props, eye);
      updateTiles(shelters.group, eye);
      shelters.update(night);
      signals.update();
      for (const t of tiled) updateTiles(t, eye);
    },
  };
}

function addMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  opts: { cast?: boolean; receive?: boolean; name: string },
) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = opts.name;
  mesh.castShadow = opts.cast ?? false;
  mesh.receiveShadow = opts.receive ?? false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  group.add(mesh);
  return mesh;
}

/** The raised sidewalk slab of a block: the block plus the sidewalks of the roads around it. */
export function expandBySidewalks(block: Rect, roads: Road[]): Rect {
  const r = { ...block };
  for (const road of roads) {
    const edgeLo = road.center - roadHalfWidth(road);
    const edgeHi = road.center + roadHalfWidth(road);
    // Only the stretch of the road that actually runs beside this block.
    const [lo, hi] = road.axis === 'ns' ? [block.z0, block.z1] : [block.x0, block.x1];
    if (road.to <= lo || road.from >= hi) continue;
    if (road.axis === 'ns') {
      if (Math.abs(edgeHi - block.x0) < 0.01) r.x0 -= road.sidewalk;
      if (Math.abs(edgeLo - block.x1) < 0.01) r.x1 += road.sidewalk;
    } else {
      if (Math.abs(edgeHi - block.z0) < 0.01) r.z0 -= road.sidewalk;
      if (Math.abs(edgeLo - block.z1) < 0.01) r.z1 += road.sidewalk;
    }
  }
  return r;
}

/** Stretches of a road between the junction boxes of the roads that really cross it. */
export function segmentsBetweenJunctions(road: Road, roads: Road[]): [number, number][] {
  const crossings = roads
    .filter(
      (c) => c.axis !== road.axis && road.center >= c.from - 1e-6 && road.center <= c.to + 1e-6,
    )
    .map((c) => [c.center - carriageHalfWidth(c), c.center + carriageHalfWidth(c)] as const)
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = road.from;
  for (const [lo, hi] of crossings) {
    if (hi <= road.from || lo >= road.to) continue;
    if (lo > at) out.push([at, lo]);
    at = Math.max(at, hi);
  }
  if (at < road.to) out.push([at, road.to]);
  return out;
}

/** Lane lines, centre lines, stop lines and continental crosswalks, by tile. */
function buildMarkings(city: CityLayout, tiles: TiledGeo<'white' | 'yellow'>) {
  // Paint strips in road coordinates: along = position along the road, across = offset.
  const strip = (
    paint: 'white' | 'yellow',
    r: Road,
    a0: number,
    a1: number,
    c0: number,
    c1: number,
  ) =>
    tiles.split(a0, a1, (b0, b1) => {
      const mid = (b0 + b1) / 2;
      if (r.axis === 'ns')
        tiles.at(r.center, mid)[paint].flat(r.center + c0, b0, r.center + c1, b1, MARK_Y, 1);
      else tiles.at(mid, r.center)[paint].flat(b0, r.center + c0, b1, r.center + c1, MARK_Y, 1);
    });
  for (const r of city.roads) {
    const half = carriageHalfWidth(r);
    for (const [s0, s1] of segmentsBetweenJunctions(r, city.roads)) {
      const a0 = s0 + 4.5;
      const a1 = s1 - 4.5;
      if (a1 <= a0) continue;
      if (r.median === 0) {
        strip('yellow', r, a0, a1, -0.22, -0.1);
        strip('yellow', r, a0, a1, 0.1, 0.22);
      }
      // Dashed lane separators within each direction: 3 m paint, 9 m gap.
      for (let lane = 1; lane < r.lanesPerDir; lane += 1) {
        const off = r.median / 2 + lane * r.laneWidth;
        for (let a = a0 + 2; a + 3 < a1; a += 12) {
          strip('white', r, a, a + 3, off - 0.06, off + 0.06);
          strip('white', r, a, a + 3, -off - 0.06, -off + 0.06);
        }
      }
      // Crosswalks and stop lines at both ends of the segment.
      for (const [edge, dir] of [
        [s0, 1],
        [s1, -1],
      ] as const) {
        if (edge <= r.from + 0.01 || edge >= r.to - 0.01) continue;
        for (let c = -half + 0.5; c + 0.6 < half; c += 1.2) {
          const p0 = edge + dir * 0.6;
          const p1 = edge + dir * 3.6;
          strip('white', r, Math.min(p0, p1), Math.max(p0, p1), c, c + 0.6);
        }
        const stop0 = edge + dir * 4.2;
        const stop1 = edge + dir * 4.6;
        // Stop lines cover the lanes that approach this junction (right-hand traffic).
        const [c0, c1] = dir > 0 ? [-half, -r.median / 2] : [r.median / 2, half];
        strip('white', r, Math.min(stop0, stop1), Math.max(stop0, stop1), c0, c1);
      }
    }
  }
}

function buildPlaza(
  group: THREE.Group,
  p: Rect,
  m: { paving: THREE.Material; grass: THREE.Material; concrete: THREE.Material },
) {
  const cx = (p.x0 + p.x1) / 2;
  const cz = (p.z0 + p.z1) / 2;
  const top = SLAB_Y + 0.004;
  const paved = new GeoBuilder().flat(p.x0, p.z0, p.x1, p.z1, top, 1.8);
  addMesh(group, paved.build(), m.paving, { receive: true, name: 'plaza-paving' });
  // Four lawns cut by a cross of paths, with a low concrete edging. Flush with the paving:
  // the physics has no lawns, and raised ones (10 cm) swallowed the player's feet.
  const lawns = new GeoBuilder();
  const edging = new GeoBuilder();
  const path = 5;
  const inset = 4;
  const quads: Rect[] = [
    { x0: p.x0 + inset, z0: p.z0 + inset, x1: cx - path, z1: cz - path },
    { x0: cx + path, z0: p.z0 + inset, x1: p.x1 - inset, z1: cz - path },
    { x0: p.x0 + inset, z0: cz + path, x1: cx - path, z1: p.z1 - inset },
    { x0: cx + path, z0: cz + path, x1: p.x1 - inset, z1: p.z1 - inset },
  ];
  for (const q of quads) {
    edging.box(q.x0 - 0.25, top, q.z0 - 0.25, q.x1 + 0.25, top + 0.04, q.z1 + 0.25, 2, false);
    lawns.flat(q.x0, q.z0, q.x1, q.z1, top + 0.006, 4);
  }
  addMesh(group, lawns.build(), m.grass, { receive: true, name: 'plaza-lawns' });
  addMesh(group, edging.build(), m.concrete, { receive: true, name: 'plaza-edging' });

  // Fountain: stone basin, still water, central column.
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(9, 9.3, 0.7, 48, 1, true), m.concrete);
  basin.position.set(cx, top + 0.35, cz);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(9.1, 0.35, 8, 64), m.concrete);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(cx, top + 0.7, cz);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.MeshStandardMaterial({ color: 0x2f5560, roughness: 0.04, metalness: 0.4 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(cx, top + 0.5, cz);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.2, 3.2, 24), m.concrete);
  column.position.set(cx, top + 1.6, cz);
  for (const mesh of [basin, rim, water, column]) {
    mesh.receiveShadow = true;
    mesh.castShadow = mesh !== water;
    group.add(mesh);
  }
}

type Facades = Record<FacadeKind, GeoBuilder>;

function facadeBuilders(): Facades {
  const make = () =>
    new GeoBuilder().attribute('aBld', 4, [0, 4, 0, 3]).attribute('aTint', 3, [1, 1, 1]);
  return { glass: make(), tiles: make(), stucco: make(), brick: make(), cladding: make() };
}

function addBuilding(f: Facades, b: Building) {
  const r = rng(b.seed);
  const x0 = b.x - b.w / 2;
  const x1 = b.x + b.w / 2;
  const z0 = b.z - b.d / 2;
  const z1 = b.z + b.d / 2;
  const base = SLAB_Y + (b.y ?? 0);
  const top = base + b.h;
  const seed = (b.seed % 10_000) / 10_000;
  const box = (kind: FacadeKind, inset: number, y0: number, y1: number, floor = b.floorHeight) => {
    const tint = new THREE.Color(r.pick(TINTS[kind]));
    f[kind].set('aBld', [seed, floor, base, BAY[kind]]).set('aTint', [tint.r, tint.g, tint.b]);
    f[kind].box(x0 + inset, y0, z0 + inset, x1 - inset, y1, z1 - inset, 1);
  };
  switch (b.style) {
    case 'glass_tower': {
      // Stone podium, glass shaft, slimmer crown: the downtown skyline silhouette.
      const podium = Math.min(14, b.h * 0.15);
      box('tiles', 0, base, base + podium, 4.6);
      box('glass', 1.5, base + podium, top - b.h * 0.12, b.floorHeight);
      box('glass', Math.min(b.w, b.d) * 0.18, top - b.h * 0.12, top, b.floorHeight);
      break;
    }
    case 'deco': {
      // Art Deco set-backs.
      const step = Math.min(b.w, b.d) * 0.1;
      box('tiles', 0, base, base + b.h * 0.6);
      box('tiles', step, base + b.h * 0.6, base + b.h * 0.85);
      box('tiles', step * 2.2, base + b.h * 0.85, top);
      break;
    }
    case 'office_midrise':
      box('tiles', 0, base, top);
      break;
    case 'stucco_shop':
      box('stucco', 0, base, top);
      break;
    case 'brick_loft':
      box('brick', 0, base, top);
      // Arts District skyline: timber water tanks on legs over half the lofts.
      if (b.h >= 10 && r.chance(0.5)) {
        const rad = r.range(1.4, 2);
        const cx = r.range(x0 + 2 + rad, x1 - 2 - rad);
        const cz = r.range(z0 + 2 + rad, z1 - 2 - rad);
        waterTank(f.cladding, seed, cx, cz, top, rad);
      }
      break;
    case 'warehouse':
      box('cladding', 0, base, top, 6);
      break;
    case 'house':
      box('stucco', 0, base, top, b.floorHeight);
      break;
    case 'villa': {
      // A wide ground floor and a smaller upper floor set back over it.
      const ground = base + b.floorHeight;
      box('stucco', 0, base, ground);
      box('stucco', Math.min(b.w, b.d) * 0.18, ground, top);
      break;
    }
    case 'showroom':
      // The dealership: glass all round on a low stone plinth, under a white roof slab that
      // overhangs it (drawn without windows).
      box('tiles', 0, base, base + 0.6, 4.6);
      box('glass', 0.25, base + 0.6, top - 0.9, b.floorHeight);
      f.cladding.set('aBld', [seed, 1000, 1e4, 7]).set('aTint', [1.1, 1.1, 1.12]);
      f.cladding.box(x0 - 0.8, top - 0.9, z0 - 0.8, x1 + 0.8, top, z1 + 0.8, 1);
      break;
    case 'civic':
      // City hall and the observatory: pale limestone (landmarks.ts adds their tops).
      f.tiles
        .set('aBld', [seed, b.floorHeight, base, 2.4])
        .set(
          'aTint',
          b.service === 'hospital'
            ? [2.1, 2.1, 2.05]
            : b.service === 'police'
              ? [0.72, 0.86, 1.25]
              : [1.04, 1.01, 0.95],
        );
      f.tiles.box(x0, base, z0, x1, top, z1, 1);
      break;
  }
  // Rooftop plant: AC units and stair housings (drawn without windows), not on homes.
  const plain = b.style === 'house' || b.style === 'villa';
  if (b.h < 70 && !plain && b.style !== 'civic') {
    const units = r.int(1, 4);
    for (let i = 0; i < units; i += 1) {
      const w = r.range(1.5, 3.5);
      const d = r.range(1.5, 3);
      const cx = r.range(x0 + 2 + w, x1 - 2 - w);
      const cz = r.range(z0 + 2 + d, z1 - 2 - d);
      f.cladding.set('aBld', [seed, 1000, 1e4, 7]).set('aTint', [0.75, 0.76, 0.76]);
      f.cladding.box(
        cx - w / 2,
        top,
        cz - d / 2,
        cx + w / 2,
        top + r.range(1.2, 2.6),
        cz + d / 2,
        1,
      );
    }
  }
}

/** A rooftop water tank: legs, a timber drum and a conical cap (drawn without windows). */
function waterTank(g: GeoBuilder, seed: number, cx: number, cz: number, y: number, rad: number) {
  const SIDES = 10;
  const legs = 2.4;
  const y0 = y + legs;
  const y1 = y0 + rad * 1.7;
  g.set('aBld', [seed, 1000, 1e4, 7]).set('aTint', [0.32, 0.33, 0.34]);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const lx = cx + sx * rad * 0.62;
    const lz = cz + sz * rad * 0.62;
    g.box(lx - 0.12, y, lz - 0.12, lx + 0.12, y0, lz + 0.12, 1, false);
  }
  g.box(cx - rad * 0.8, y0 - 0.2, cz - rad * 0.8, cx + rad * 0.8, y0, cz + rad * 0.8, 1);
  g.set('aTint', [0.62, 0.45, 0.3]);
  const p = (a: number, h: number, k = rad) =>
    new THREE.Vector3(cx + Math.cos(a) * k, h, cz + Math.sin(a) * k);
  for (let i = 0; i < SIDES; i += 1) {
    const a0 = (i / SIDES) * Math.PI * 2;
    const a1 = ((i + 1) / SIDES) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    // Seen from outside, the reader's right is towards smaller angles.
    g.quad(
      p(a1, y0),
      p(a0, y0),
      p(a0, y1),
      p(a1, y1),
      new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)),
      [0, 0, 1, 0, 1, 1, 0, 1],
    );
    g.tri(
      p(a1, y1, rad * 1.04),
      p(a0, y1, rad * 1.04),
      new THREE.Vector3(cx, y1 + rad * 0.55, cz),
      new THREE.Vector3(Math.cos(mid) * 0.5, 0.87, Math.sin(mid) * 0.5),
      [0, 0, 1, 0, 0.5, 1],
    );
  }
}

/**
 * The elevated freeways: deck, driving surface, Jersey barriers, pillars with bent caps, lane
 * paint. Built along the freeway's own axis (`a` along, `c` across) and placed in x/z.
 */
function buildFreeways(
  group: THREE.Group,
  city: CityLayout,
  m: { road: THREE.Material; concrete: THREE.Material },
) {
  const deck = new GeoBuilder();
  const surface = new GeoBuilder();
  const solid = new GeoBuilder();
  const lines = new GeoBuilder();
  for (const fw of city.freeways) {
    const half = fw.width / 2;
    const y = fw.deckY;
    const xz = (a0: number, c0: number, a1: number, c1: number) =>
      fw.axis === 'ew'
        ? ([a0, fw.center + c0, a1, fw.center + c1] as const)
        : ([fw.center + c0, a0, fw.center + c1, a1] as const);
    const box = (
      g: GeoBuilder,
      a0: number,
      c0: number,
      a1: number,
      c1: number,
      y0: number,
      y1: number,
      tile: number,
      top = true,
    ) => {
      const [x0, z0, x1, z1] = xz(a0, c0, a1, c1);
      g.box(x0, y0, z0, x1, y1, z1, tile, top);
    };
    const flat = (
      g: GeoBuilder,
      a0: number,
      c0: number,
      a1: number,
      c1: number,
      yy: number,
      tile: number,
    ) => {
      const [x0, z0, x1, z1] = xz(a0, c0, a1, c1);
      g.flat(x0, z0, x1, z1, yy, tile);
    };
    box(deck, fw.from, -half, fw.to, half, y - 1.4, y - 0.01, 3, false);
    flat(surface, fw.from, -half + 0.6, fw.to, half - 0.6, y, 8);
    // Jersey barriers along both edges (open where a ramp joins) and the centre.
    const gaps = barrierGaps(fw, city.ramps);
    for (const [side, c] of [
      [-1, -half + 0.3],
      [1, half - 0.3],
      [0, 0],
    ] as const) {
      let at = fw.from;
      const open = gaps.filter(([s]) => s === side).sort((p, q) => p[1] - q[1]);
      for (const [, g0, g1] of [...open, [side, fw.to, fw.to] as const]) {
        if (g0 > at) box(solid, at, c - 0.3, g0, c + 0.3, y, y + 0.85, 2);
        at = Math.max(at, g1);
      }
    }
    const caps = new Set<number>();
    for (const p of fw.pillars) {
      // Down to the channel floor where a pillar stands in the river.
      const foot = Math.min(-0.02, terrainHeight(p.x, p.z));
      solid.box(p.x - p.w / 2, foot, p.z - p.d / 2, p.x + p.w / 2, y - 1.4, p.z + p.d / 2, 2);
      caps.add(fw.axis === 'ew' ? p.x : p.z);
    }
    // Bent caps under the deck, one per pillar pair.
    for (const a of caps) box(solid, a - 1.3, -half + 1, a + 1.3, half - 1, y - 2.4, y - 1.4, 2);
    for (const side of [-1, 1]) {
      for (let lane = 1; lane < 3; lane += 1) {
        const c = side * (0.6 + lane * 3.6);
        for (let a = fw.from + 3; a < fw.to - 3; a += 12)
          flat(lines, a, c - 0.07, a + 3, c + 0.07, y + 0.012, 1);
      }
    }
  }
  addMesh(group, deck.build(), m.concrete, { cast: true, receive: true, name: 'freeway-deck' });
  addMesh(group, surface.build(), m.road, { receive: true, name: 'freeway-surface' });
  addMesh(group, solid.build(), m.concrete, {
    cast: true,
    receive: true,
    name: 'freeway-structure',
  });
  const paint = new THREE.MeshStandardMaterial({
    color: 0xe9e6df,
    roughness: 0.75,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  addMesh(group, lines.build(), paint, { receive: true, name: 'freeway-lines' });
}

/** A flat polygon (x, z pairs) at height y, for large plain areas of ground. */
function polygon(
  points: readonly (readonly [number, number])[],
  y: number,
  holes: readonly (readonly (readonly [number, number])[])[] = [],
): THREE.BufferGeometry {
  // Shapes live in x/y; y = -z so that rotating onto the ground keeps the winding facing up.
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const hole of holes) {
    shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
  }
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/**
 * Beach width at a coast point (m): wide on the Pacific and the south shore, a strip under the
 * mountains and along the port, none at the harbour quay.
 */
function beachWidth(x: number, z: number): number {
  if (z >= HARBOUR.z0 - 1 && x >= HARBOUR.x0 - 1) return 0;
  return x < -900 || z > 1100 ? 110 : 30;
}

/** The beach: a strip all round the island's shore, inside the coast (land on its left). */
function beachStrip(y: number): THREE.BufferGeometry {
  const n = COAST.length;
  const at = (i: number) => COAST[(i + n) % n] as readonly [number, number];
  const inner = COAST.map(([x, z], i) => {
    const [px, pz] = at(i - 1);
    const [nx, nz] = at(i + 1);
    const len = Math.hypot(nx - px, nz - pz) || 1;
    const w = beachWidth(x, z);
    return [x + ((nz - pz) / len) * w, z - ((nx - px) / len) * w] as const;
  });
  type P = readonly [number, number];
  const pos: number[] = [];
  const tri = ([px, pz]: P, q: P, r: P) => {
    // Wound to face up.
    const cross = (q[0] - px) * (r[1] - pz) - (q[1] - pz) * (r[0] - px);
    const [[bx, bz], [cx, cz]] = cross < 0 ? [q, r] : [r, q];
    pos.push(px, y, pz, bx, y, bz, cx, y, cz);
  };
  for (let i = 0; i < n; i += 1) {
    const a = at(i);
    const b = at(i + 1);
    const c = inner[(i + 1) % n] as P;
    const d = inner[i] as P;
    tri(a, b, c);
    tri(a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * `overlay`: drawn over the land a few millimetres below it with that much depth bias (the
 * depth buffer can't separate 1.5 cm at a few hundred metres: the land showed through).
 */
function flatMaterial(color: number, roughness: number, metalness = 0, overlay = 0) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    polygonOffset: overlay > 0,
    polygonOffsetFactor: -overlay,
    polygonOffsetUnits: -overlay,
  });
}

/**
 * The sea (one big plane under everything), the land cut to the coastline and the harbour,
 * a sand beach along the shore, the green hills to the north, the quarry, and the concrete
 * river channel with its trickle of water. Plain colours for now (greybox); the art pass
 * gives each its textures.
 */
function buildGround(group: THREE.Group, concrete: THREE.Material) {
  // The sea and the flat land, both open where the river channel is sunk below them
  // (ground.ts draws the channel; a whole sea plane at -0.6 m covered it like a lid).
  const R = RIVER;
  const riverHole: [number, number][] = [
    [R.x0, R.z0],
    [R.x0, R.z1],
    [R.x1, R.z1],
    [R.x1, R.z0],
  ];
  const far = 6000;
  const sea = new THREE.Mesh(
    polygon(
      [
        [-far, -far],
        [-far, far],
        [far, far],
        [far, -far],
      ],
      -0.6,
      [riverHole],
    ),
    flatMaterial(0x2b6f8c, 0.12, 0.05),
  );
  sea.name = 'sea';
  sea.receiveShadow = true;
  sea.matrixAutoUpdate = false;
  group.add(sea);

  addMesh(group, polygon(landOutline(), -0.02, [riverHole]), concrete, {
    receive: true,
    name: 'land',
  });

  addMesh(group, beachStrip(-0.01), flatMaterial(0xd8c8a2, 0.95, 0, 1), {
    receive: true,
    name: 'beach',
  });
}
