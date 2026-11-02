/**
 * The hills' cover (owner, 2026-10-29: a real mountainside, not smooth green, and players keep
 * to the roads): boulders of the hillside's own rock and clumps of dark chaparral scrub, off
 * the hill roads and villa pads (offRoadInHills), thicker on the steeper ground. Placed by a
 * jittered grid from a fixed seed (the same on every device), instanced per 400 m tile and
 * drawn to a tier's distance. The boulders are also solid to the player (physics.ts reads
 * `hillBoulders`), so the slopes can't be walked straight up between them everywhere.
 */
import { hash2, offRoadInHills, rng, terrainHeight } from '@fr33world/city';
import * as THREE from 'three';
import type { Textures } from '../materials.ts';
import type { Tier } from '../quality.ts';
import { byTile, tileGroup } from './tiles.ts';

/** How far the cover is drawn per tier (m). */
const DISTANCE: Record<Tier, number> = { low: 260, medium: 420, high: 620, ultra: 850 };
/** Grid spacing (m): one candidate per cell, kept or not by slope and chance. */
const SPACING = 12;
/** How much of the scrub each tier draws (boulders are the same everywhere: they collide). */
const SCRUB: Record<Tier, number> = { low: 0.45, medium: 0.75, high: 1, ultra: 1 };
/** Where the hills are (north of the city's edge). */
const HILLS = { x0: -1400, x1: 1400, z0: -1500, z1: -850 };

export interface Cover {
  x: number;
  y: number;
  z: number;
  size: number;
  yaw: number;
  /** 0 a boulder, 1 scrub. */
  kind: 0 | 1;
}

/** Smooth 0–1 noise (patches, not specks). */
function smooth(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const u = (x - xi) ** 2 * (3 - 2 * (x - xi));
  const v = (z - zi) ** 2 * (3 - 2 * (z - zi));
  const at = (a: number, b: number) => hash2(a, b) / 4294967296;
  const top = at(xi, zi) + (at(xi + 1, zi) - at(xi, zi)) * u;
  const bottom = at(xi, zi + 1) + (at(xi + 1, zi + 1) - at(xi, zi + 1)) * u;
  return top + (bottom - top) * v;
}

/** A fixed 0–1 value for a place and a purpose (`salt`). */
function chance(x: number, z: number, salt: number): number {
  return hash2(Math.round(x * 8) ^ (salt * 0x9e37), Math.round(z * 8) + salt * 7919) / 4294967296;
}

let cached: Cover[] | null = null;

/** The cover's places (fixed seed: the same on every device and tier). */
export function hillCover(): Cover[] {
  if (cached) return cached;
  const spacing = SPACING;
  const spots: Cover[] = [];
  for (let x = HILLS.x0; x < HILLS.x1; x += spacing) {
    for (let z = HILLS.z0; z < HILLS.z1; z += spacing) {
      const jx = x + (chance(x, z, 11) - 0.5) * spacing * 0.9;
      const jz = z + (chance(x, z, 12) - 0.5) * spacing * 0.9;
      if (!offRoadInHills(jx, jz, 5)) continue;
      const h = terrainHeight(jx, jz);
      const steep = Math.min(
        1,
        Math.hypot(terrainHeight(jx + 2, jz) - h, terrainHeight(jx, jz + 2) - h) / 2,
      );
      // Chaparral grows in patches (a large-scale noise), thicker on the steeper ground;
      // some open meadow is kept low down. Rock shows most where it's steepest.
      const patch = smooth(jx / 70, jz / 70);
      const keep = 0.2 + steep * 0.8 + (patch - 0.5) * 0.9 - (h < 15 ? 0.25 : 0);
      if (chance(jx, jz, 13) > keep) continue;
      const boulder = chance(jx, jz, 14) < 0.12 + steep * 0.45;
      spots.push({
        x: jx,
        y: h,
        z: jz,
        size: boulder ? 0.8 + chance(jx, jz, 15) ** 2 * 3 : 1.6 + chance(jx, jz, 15) * 1.8,
        yaw: chance(jx, jz, 16) * Math.PI * 2,
        kind: boulder ? 0 : 1,
      });
    }
  }
  cached = spots;
  return spots;
}

/** The boulders the player can't walk through (positions and radius), for physics.ts. */
export function hillBoulders(): { x: number; y: number; z: number; r: number }[] {
  return hillCover()
    .filter((c) => c.kind === 0 && c.size > 1.4)
    .map((c) => ({ x: c.x, y: c.y, z: c.z, r: c.size * 0.8 }));
}

/** A lumpy rock: an icosphere pushed about by a fixed noise, flattened, half sunk. */
function boulderGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const r = rng(0xb01d);
  // Facets: cut by a few planes, so it reads as broken rock rather than a pebble.
  const planes = Array.from({ length: 9 }, () =>
    new THREE.Vector3(r.range(-1, 1), r.range(-0.4, 1), r.range(-1, 1)).normalize(),
  );
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 1) {
    v.fromBufferAttribute(p, i).normalize();
    let k = 1.15;
    for (const n of planes) k = Math.min(k, 0.78 / Math.max(0.2, v.dot(n)));
    v.multiplyScalar(k);
    v.x *= 1.25;
    v.y = v.y * 0.75 - 0.2;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  // The rock photo projected from whichever side each face looks (no stretching).
  const fp = flat.attributes.position as THREE.BufferAttribute;
  const fn = flat.attributes.normal as THREE.BufferAttribute;
  const uv = flat.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < fp.count; i += 1) {
    const ax = Math.abs(fn.getX(i));
    const ay = Math.abs(fn.getY(i));
    const az = Math.abs(fn.getZ(i));
    const [a, b] =
      ay > ax && ay > az
        ? [fp.getX(i), fp.getZ(i)]
        : ax > az
          ? [fp.getZ(i), fp.getY(i)]
          : [fp.getX(i), fp.getY(i)];
    uv.setXY(i, a * 0.35, b * 0.35);
  }
  return flat;
}

/** A scrub clump: a few squashed, overlapping blobs of dark leaves. */
function scrubGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = rng(0x5c2b);
  const colour = new THREE.Color();
  for (let k = 0; k < 4; k += 1) {
    const blob = new THREE.IcosahedronGeometry(r.range(0.45, 0.7), 1);
    blob.scale(1, 0.72, 1);
    blob.translate(r.range(-0.45, 0.45), r.range(0.25, 0.5), r.range(-0.45, 0.45));
    const p = blob.attributes.position as THREE.BufferAttribute;
    const cols = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i += 1) {
      // Darker underneath; olive and sage greens, a few dry tips.
      colour.set(r.pick([0x24301a, 0x2e3b1d, 0x374223, 0x4a4a2a]));
      colour.multiplyScalar(0.55 + 0.45 * Math.max(0, p.getY(i)));
      cols.set([colour.r, colour.g, colour.b], i * 3);
    }
    blob.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(blob.toNonIndexed());
  }
  const merged = new THREE.BufferGeometry();
  const count = parts.reduce(
    (a, g) => a + (g.attributes.position as THREE.BufferAttribute).count,
    0,
  );
  for (const name of ['position', 'normal', 'color']) {
    const out = new Float32Array(count * 3);
    let at = 0;
    for (const g of parts) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      out.set(a.array, at);
      at += a.array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(out, 3));
  }
  merged.computeVertexNormals();
  return merged;
}

export function buildHillCover(textures: Textures, tier: Tier): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hill-cover';
  const reach = DISTANCE[tier];
  const rockMaterial = new THREE.MeshStandardMaterial({
    map: textures.get('hill_rock_color.webp', true),
    color: 0x9da2a6,
    roughness: 0.95,
  });
  const scrubMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    envMapIntensity: 0.3,
  });
  const boulder = boulderGeometry();
  const scrub = scrubGeometry();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const cover = hillCover().filter((c) => c.kind === 0 || chance(c.x, c.z, 17) < SCRUB[tier]);
  for (const tile of byTile(cover)) {
    const root = tileGroup(tile, reach);
    for (const kind of [0, 1] as const) {
      const mine = tile.filter((c) => c.kind === kind);
      if (mine.length === 0) continue;
      const mesh = new THREE.InstancedMesh(
        kind === 0 ? boulder : scrub,
        kind === 0 ? rockMaterial : scrubMaterial,
        mine.length,
      );
      mine.forEach((c, i) => {
        q.setFromAxisAngle(up, c.yaw);
        const s = c.size;
        m.compose(
          new THREE.Vector3(c.x, c.y, c.z),
          q,
          new THREE.Vector3(s, s * (kind ? 0.8 : 1), s),
        );
        mesh.setMatrixAt(i, m);
      });
      mesh.name = kind === 0 ? 'boulders' : 'scrub';
      mesh.castShadow = tier !== 'low';
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      root.add(mesh);
    }
    group.add(root);
  }
  return group;
}
