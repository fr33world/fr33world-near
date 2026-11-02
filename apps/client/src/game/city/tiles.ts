/**
 * City tiles: everything spread across the whole city is split into square tiles, each its
 * own small group, so the GPU only draws tiles that are near and in view. Frustum culling
 * skips tiles behind the camera and outside the sun's shadow box (three.js, per mesh bounds);
 * tiles beyond a tier's draw distance are hidden by `updateTiles`. Without this, every palm,
 * lamp, wall and road in the city went through the GPU each frame, twice with shadows.
 *
 * Small details use 400 m tiles and short draw distances; buildings, roads and ground use
 * `BIG_TILE` (fewer draw calls, they are seen from far anyway).
 */
import * as THREE from 'three';
import type { Tier } from '../quality.ts';
import type { GeoBuilder } from './geo.ts';

export const TILE = 400;
export const BIG_TILE = 800;

/** How far small street details are drawn per tier (m): paint, doors, hedges, shop signs. */
export const DETAIL_DISTANCE: Record<Tier, number> = {
  low: 250,
  medium: 350,
  high: 450,
  ultra: 600,
};

interface TileInfo {
  cx: number;
  cz: number;
  size: number;
  /** Farthest the tile is drawn, from its nearest edge (m). */
  maxDistance: number;
  /** Optional detail levels: `near` within `nearDistance`, `far` beyond it. */
  lod?: { near: THREE.Object3D; far: THREE.Object3D; nearDistance: number };
  /** Optional instanced meshes drawing only what's within their reach (`setInstanceReach`). */
  reach?: InstanceReach[];
}

interface InstanceReach {
  mesh: THREE.InstancedMesh;
  /** Every instance's matrix; the mesh holds only those in reach. */
  all: Float32Array;
  reach: number;
  /** Where the eye was at the last sort. */
  x: number;
  z: number;
}

/** The eye moves this far (m) before a tile's instances are sorted again. */
const REACH_STEP = 8;

/** Gives a tile a detailed version for close up and a light one for distance. */
export function setTileLod(
  tile: THREE.Group,
  near: THREE.Object3D,
  far: THREE.Object3D,
  nearDistance: number,
): void {
  const info = tile.userData.tile as TileInfo | undefined;
  if (info) info.lod = { near, far, nearDistance };
}

/**
 * Draws only the instances of `mesh` within `reach` metres of the eye. A tile's own draw distance
 * counts from its edge, so without this one near tile draws everything in it, up to 400 m further
 * than that: small props no one can see, in a phone's triangles. Call it with every instance set.
 */
export function setInstanceReach(
  tile: THREE.Group,
  mesh: THREE.InstancedMesh,
  reach: number,
): void {
  const info = tile.userData.tile as TileInfo | undefined;
  if (!info) return;
  const all = (mesh.instanceMatrix.array as Float32Array).slice();
  (info.reach ??= []).push({ mesh, all, reach, x: Infinity, z: Infinity });
}

function sortInstances(r: InstanceReach, eye: THREE.Vector3, reach: number): void {
  const mx = eye.x - r.x;
  const mz = eye.z - r.z;
  if (mx * mx + mz * mz < REACH_STEP * REACH_STEP) return;
  r.x = eye.x;
  r.z = eye.z;
  const out = r.mesh.instanceMatrix.array;
  let n = 0;
  for (let i = 0; i < r.all.length; i += 16) {
    const dx = (r.all[i + 12] ?? 0) - eye.x;
    const dz = (r.all[i + 14] ?? 0) - eye.z;
    if (dx * dx + dz * dz > reach * reach) continue;
    for (let k = 0; k < 16; k += 1) out[n + k] = r.all[i + k] ?? 0;
    n += 16;
  }
  r.mesh.count = n / 16;
  r.mesh.instanceMatrix.needsUpdate = true;
}

/** Splits positioned items by tile. */
export function byTile<T extends { x: number; z: number }>(items: readonly T[]): T[][] {
  const tiles = new Map<string, T[]>();
  for (const item of items) {
    const key = `${Math.floor(item.x / TILE)},${Math.floor(item.z / TILE)}`;
    let list = tiles.get(key);
    if (!list) tiles.set(key, (list = []));
    list.push(item);
  }
  return [...tiles.values()];
}

/** A group for one tile's items, culled by distance from the camera. */
export function tileGroup(
  items: readonly { x: number; z: number }[],
  maxDistance: number,
): THREE.Group {
  const first = items[0];
  const g = new THREE.Group();
  if (!first) return g;
  const info: TileInfo = {
    cx: (Math.floor(first.x / TILE) + 0.5) * TILE,
    cz: (Math.floor(first.z / TILE) + 0.5) * TILE,
    size: TILE,
    maxDistance,
  };
  g.userData.tile = info;
  return g;
}

export interface MeshSpec {
  material: THREE.Material;
  name: string;
  cast?: boolean;
  /** Default true. */
  receive?: boolean;
}

/**
 * Geometry builders split by tile: `at(x, z)` gives the builders of the tile holding that
 * point (place each item by its centre; items may overhang their tile a little).
 */
export class TiledGeo<K extends string> {
  private readonly tiles = new Map<
    string,
    { tx: number; tz: number; parts: Record<K, GeoBuilder> }
  >();

  private readonly make: () => Record<K, GeoBuilder>;
  readonly size: number;

  constructor(make: () => Record<K, GeoBuilder>, size = TILE) {
    this.make = make;
    this.size = size;
  }

  at(x: number, z: number): Record<K, GeoBuilder> {
    const tx = Math.floor(x / this.size);
    const tz = Math.floor(z / this.size);
    const key = `${tx},${tz}`;
    let tile = this.tiles.get(key);
    if (!tile) this.tiles.set(key, (tile = { tx, tz, parts: this.make() }));
    return tile.parts;
  }

  /**
   * Cuts the span [a0, a1] at tile borders (for long strips such as roads), calling `each`
   * with every piece.
   */
  split(a0: number, a1: number, each: (b0: number, b1: number) => void): void {
    let at = a0;
    while (at < a1) {
      const next = Math.min(a1, (Math.floor(at / this.size + 1e-9) + 1) * this.size);
      each(at, next);
      at = next;
    }
  }

  /** A group of tiles drawn within `maxDistance`, one mesh per non-empty part per tile. */
  build(specs: Record<K, MeshSpec>, maxDistance: number, name: string): THREE.Group {
    const root = new THREE.Group();
    root.name = name;
    for (const { tx, tz, parts } of this.tiles.values()) {
      const g = new THREE.Group();
      const info: TileInfo = {
        cx: (tx + 0.5) * this.size,
        cz: (tz + 0.5) * this.size,
        size: this.size,
        maxDistance,
      };
      g.userData.tile = info;
      for (const key of Object.keys(parts) as K[]) {
        const builder = parts[key];
        if (builder.vertexCount === 0) continue;
        const spec = specs[key];
        const mesh = new THREE.Mesh(builder.build(), spec.material);
        mesh.name = spec.name;
        mesh.castShadow = spec.cast ?? false;
        mesh.receiveShadow = spec.receive ?? true;
        mesh.matrixAutoUpdate = false;
        g.add(mesh);
      }
      if (g.children.length > 0) root.add(g);
    }
    return root;
  }
}

/** Dev (?mapshot): every tile shown in full detail, for drawing the map from above. */
export const SHOW_ALL_TILES = { on: false };

/** Shows the tiles under `root` within their draw distance of `eye`, hides the rest. */
export function updateTiles(root: THREE.Object3D, eye: THREE.Vector3): void {
  for (const child of root.children) {
    const t = child.userData.tile as TileInfo | undefined;
    if (!t) continue;
    if (SHOW_ALL_TILES.on) {
      child.visible = true;
      if (t.lod) {
        t.lod.near.visible = true;
        t.lod.far.visible = false;
      }
      for (const r of t.reach ?? []) sortInstances(r, eye, Infinity);
      continue;
    }
    // Distance from the eye to the tile's square (0 inside it).
    const dx = Math.max(0, Math.abs(eye.x - t.cx) - t.size / 2);
    const dz = Math.max(0, Math.abs(eye.z - t.cz) - t.size / 2);
    const d2 = dx * dx + dz * dz;
    child.visible = d2 <= t.maxDistance * t.maxDistance;
    if (t.lod) {
      const near = d2 <= t.lod.nearDistance * t.lod.nearDistance;
      t.lod.near.visible = near;
      t.lod.far.visible = !near;
    }
    if (child.visible) for (const r of t.reach ?? []) sortInstances(r, eye, r.reach);
  }
}
