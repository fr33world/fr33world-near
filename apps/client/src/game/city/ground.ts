/**
 * The terrain's ground mesh (terrain.ts in @fr33world/city): hills, mountains, the quarry and
 * the river channel, in 400 m tiles with two levels of detail. Near tiles use the 4 m samples
 * the physics stands on; far tiles an 8 m grid. Flat cells are left out (the flat land under
 * the city is drawn by city.ts), and tile edges hang skirts so no cracks show where a detailed
 * tile meets a coarse one. Colour comes from height, slope and place: green foothills, golden
 * dry grass, dark scrub higher up, bare rock on the cliffs, concrete in the river channel.
 */
import {
  inside,
  LAKE,
  lakeEdgeDistance,
  QUARRY,
  type Rect,
  RIVER,
  RIVER_DEPTH,
  RIVER_FLOOR,
  RIVER_RAMP,
  SEA_FLOOR,
  TERRAIN_REGIONS,
  TERRAIN_STEP,
  terrainHeight,
} from '@fr33world/city';
import * as THREE from 'three';
import type { Textures } from '../materials.ts';
import type { Quality } from '../quality.ts';
import { GeoBuilder } from './geo.ts';
import { setTileLod, TILE } from './tiles.ts';

/** The far mesh's grid: fine enough that the ground beside a hill road doesn't cover it. */
const FAR_STEP = 8;
const SKIRT = 6;
/** Tiles nearer than this (m, from the tile's edge) use the detailed mesh. */
const DETAIL_DISTANCE: Record<Quality['tier'], number> = {
  low: 120,
  medium: 220,
  high: 320,
  ultra: 450,
};

/**
 * Darker than they look: the sun and the sky light this scene strongly (the city's own
 * concrete is about 0.07 in linear terms), and mid tones came out nearly white.
 */
const TONE = 0.42;
const C = {
  meadow: new THREE.Color(0x56702f),
  dry: new THREE.Color(0x8c7040),
  scrub: new THREE.Color(0x3c4824),
  rock: new THREE.Color(0x66594c),
  sand: new THREE.Color(0xc4b089),
  concrete: new THREE.Color(0x8a877f),
  gravel: new THREE.Color(0x968266),
  seabed: new THREE.Color(0x4f493c),
};

/** Grid coordinates from a to b every `step` (b included even if off the step). */
function steps(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  for (let v = a; v < b - 1e-6; v += step) out.push(v);
  out.push(b);
  return out;
}

function hash(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in [0, 1) (patches of colour, not squares). */
function smoothNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const v = (z - zi) * (z - zi) * (3 - 2 * (z - zi));
  const a = hash(xi, zi) + (hash(xi + 1, zi) - hash(xi, zi)) * u;
  const b = hash(xi, zi + 1) + (hash(xi + 1, zi + 1) - hash(xi, zi + 1)) * u;
  return a + (b - a) * v;
}

/** Ground colour at a point, given its height and how steep it is (0 flat … 1 vertical). */
function groundColour(x: number, z: number, h: number, steep: number, out: THREE.Color) {
  if (inside(RIVER, x, z)) {
    // Concrete, darker and stained towards the wet floor.
    out.copy(C.concrete).multiplyScalar(TONE * (1 - 0.25 * Math.min(1, -h / RIVER_DEPTH)));
    return out;
  }
  if (h < -0.3) return out.copy(C.seabed).multiplyScalar(TONE);
  // The lake: its bed under the water; the gravel of its rim fades into the grass beyond.
  const edge = lakeEdgeDistance(x, z);
  if (edge < 0 && h < LAKE.level - 0.3) return out.copy(C.seabed).multiplyScalar(TONE);
  const shore = edge < 14 ? 1 - Math.min(1, Math.max(0, (edge - 4) / 10)) : 0;
  if (inside(QUARRY, x, z) && h < 2) return out.copy(C.gravel).multiplyScalar(TONE);
  const n = 0.65 * smoothNoise(x / 40, z / 40) + 0.35 * smoothNoise(x / 11, z / 11);
  // Green hills (owner's reference: lush, not dry): meadow low down, patches of golden grass,
  // dark scrub and chaparral covering the slopes higher up.
  const golden = Math.min(1, Math.max(0, (h - 20) / 120 + (n - 0.5) * 0.9));
  out.copy(C.meadow).lerp(C.dry, golden * 0.45);
  out.lerp(C.scrub, Math.min(1, Math.max(0, (h - 40) / 140)) * (0.45 + 0.55 * n));
  if (h < 2.5) out.lerp(C.sand, 0.5 * (1 - h / 2.5) * (1 - steep));
  out.lerp(C.rock, Math.min(1, Math.max(0, (steep - 0.62) / 0.2)) * (0.7 + 0.3 * n));
  out.lerp(C.gravel, shore * 0.85);
  return out.multiplyScalar(TONE * (0.92 + 0.16 * n));
}

/**
 * Photographed ground on the hills (owner, 2026-10-29: real hillside, not smooth green): rocky
 * grassland, forest floor under the scrub, bare rock on the steep faces, blended by slope and
 * a large-scale noise. The vertex colours (groundColour) still set each place's hue: the
 * photos only bring the detail. Rock is projected from the sides (no stretching down cliffs),
 * the rest from above. Colour maps only: normal maps projected like this lit the slopes wrong.
 */
function hillside(material: THREE.MeshStandardMaterial, textures: Textures) {
  const uniforms = {
    uGround: { value: textures.get('hill_ground_color.webp', true) },
    uDirt: { value: textures.get('hill_dirt_color.webp', true) },
    uRock: { value: textures.get('hill_rock_color.webp', true) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vHillPos;\nvarying vec3 vHillNormal;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvHillPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvHillNormal = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vHillPos;
varying vec3 vHillNormal;
uniform sampler2D uGround;
uniform sampler2D uDirt;
uniform sampler2D uRock;
float hillHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float hillNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hillHash(i), hillHash(i + vec2(1, 0)), f.x),
             mix(hillHash(i + vec2(0, 1)), hillHash(i + vec2(1, 1)), f.x), f.y);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 nrm = normalize(vHillNormal);
  float steep = 1.0 - nrm.y;
  vec2 top = vHillPos.xz;
  // Two scales of the same photo, so it never repeats visibly from afar.
  vec3 ground = mix(texture2D(uGround, top / 9.0).rgb, texture2D(uGround, top / 37.0).rgb, 0.45);
  vec3 dirt = texture2D(uDirt, top / 7.0).rgb;
  vec3 w = pow(abs(nrm), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec3 rock = texture2D(uRock, vHillPos.zy / 14.0).rgb * w.x
            + texture2D(uRock, top / 14.0).rgb * w.y
            + texture2D(uRock, vHillPos.xy / 14.0).rgb * w.z;
  float patches = hillNoise(top / 55.0) * 0.7 + hillNoise(top / 13.0) * 0.3;
  vec3 detail = mix(ground, dirt, smoothstep(0.5, 0.75, patches) * 0.8);
  detail = mix(detail, rock, smoothstep(0.22, 0.45, steep + (patches - 0.5) * 0.15));
  // The photo's light and shade over the place's own colour (vertex colour, already in
  // diffuseColor); its mean is about 0.3 in linear light, so x3.2 keeps the tone.
  diffuseColor.rgb *= clamp(detail * 3.2, 0.0, 2.2);
}`,
      );
  };
  material.customProgramCacheKey = () => 'hillside';
}

/** One tile's mesh over `r` at grid spacing `step`, with skirts round its edges. */
function tileMesh(r: Rect, step: number): THREE.BufferGeometry | null {
  const xs = steps(r.x0, r.x1, step);
  const zs = steps(r.z0, r.z1, step);
  const nx = xs.length;
  const nz = zs.length;
  const hs = new Float32Array(nx * nz);
  for (let i = 0; i < nz; i += 1) {
    for (let j = 0; j < nx; j += 1) {
      hs[i * nx + j] = terrainHeight(xs[j] as number, zs[i] as number);
    }
  }
  // Level with the flat land, or open sea floor (not the river's floor, 6 m down).
  const flat = (v: number) => Math.abs(v) < 0.01 || v === SEA_FLOOR;
  if (hs.every(flat)) return null;

  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const colour = new THREE.Color();
  const n = new THREE.Vector3();
  const e = Math.max(step, TERRAIN_STEP);
  const vertex = (x: number, z: number, h: number, colourFrom = h) => {
    n.set(
      terrainHeight(x - e, z) - terrainHeight(x + e, z),
      2 * e,
      terrainHeight(x, z - e) - terrainHeight(x, z + e),
    ).normalize();
    groundColour(x, z, colourFrom, 1 - n.y, colour);
    pos.push(x, h, z);
    nor.push(n.x, n.y, n.z);
    col.push(colour.r, colour.g, colour.b);
    uvs.push(x / 6, z / 6);
    return pos.length / 3 - 1;
  };
  for (let i = 0; i < nz; i += 1) {
    for (let j = 0; j < nx; j += 1)
      vertex(xs[j] as number, zs[i] as number, hs[i * nx + j] as number);
  }
  for (let i = 0; i < nz - 1; i += 1) {
    for (let j = 0; j < nx - 1; j += 1) {
      const k = i * nx + j;
      if ([k, k + 1, k + nx, k + nx + 1].every((c) => flat(hs[c] as number))) continue;
      // Split along (x0, z0)–(x1, z1), as Rapier's heightfield cells are; wound to face up.
      idx.push(k, k + nx + 1, k + 1, k, k + nx, k + nx + 1);
    }
  }
  // Skirts: hang each edge down a few metres (two-sided).
  const edge = (line: number[]) => {
    for (let k = 0; k < line.length - 1; k += 1) {
      const a = line[k] as number;
      const b = line[k + 1] as number;
      const ha = hs[a] as number;
      const hb = hs[b] as number;
      if (flat(ha) && flat(hb)) continue;
      const ax = pos[a * 3] as number;
      const az = pos[a * 3 + 2] as number;
      const bx = pos[b * 3] as number;
      const bz = pos[b * 3 + 2] as number;
      const da = vertex(ax, az, ha - SKIRT, ha);
      const db = vertex(bx, bz, hb - SKIRT, hb);
      idx.push(a, b, db, a, db, da, a, db, b, a, da, db);
    }
  };
  edge(Array.from({ length: nx }, (_, j) => j));
  edge(Array.from({ length: nx }, (_, j) => (nz - 1) * nx + j));
  edge(Array.from({ length: nz }, (_, i) => i * nx));
  edge(Array.from({ length: nz }, (_, i) => i * nx + nx - 1));
  if (idx.length === 0) return null;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

export function buildTerrain(quality: Quality, textures: Textures): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    // The bright sky mirrored off the ground at grazing angles (river banks looked white).
    envMapIntensity: 0.35,
    // Over the flat land where the hills begin.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  hillside(material, textures);
  for (const region of TERRAIN_REGIONS) {
    for (let tx = Math.floor(region.x0 / TILE) * TILE; tx < region.x1; tx += TILE) {
      for (let tz = Math.floor(region.z0 / TILE) * TILE; tz < region.z1; tz += TILE) {
        const r: Rect = {
          x0: Math.max(region.x0, tx),
          x1: Math.min(region.x1, tx + TILE),
          z0: Math.max(region.z0, tz),
          z1: Math.min(region.z1, tz + TILE),
        };
        if (r.x1 - r.x0 < 1 || r.z1 - r.z0 < 1) continue;
        const nearGeo = tileMesh(r, TERRAIN_STEP);
        if (!nearGeo) continue;
        const farGeo = tileMesh(r, FAR_STEP) ?? nearGeo;
        const tile = new THREE.Group();
        tile.userData.tile = {
          cx: (r.x0 + r.x1) / 2,
          cz: (r.z0 + r.z1) / 2,
          size: Math.max(r.x1 - r.x0, r.z1 - r.z0),
          maxDistance: Infinity,
        };
        const near = new THREE.Mesh(nearGeo, material);
        const far = new THREE.Mesh(farGeo, material);
        for (const m of [near, far]) {
          m.receiveShadow = true;
          m.castShadow = true;
          m.matrixAutoUpdate = false;
          tile.add(m);
        }
        setTileLod(tile, near, far, DETAIL_DISTANCE[quality.tier]);
        group.add(tile);
      }
    }
  }

  // A shallow stream down the middle of the river channel's floor.
  const mid = (RIVER_FLOOR.x0 + RIVER_FLOOR.x1) / 2;
  const water = new GeoBuilder()
    .flat(mid - 10, RIVER.z0 + RIVER_RAMP, mid + 10, RIVER.z1, -RIVER_DEPTH + 0.06, 6)
    .build();
  const stream = new THREE.Mesh(
    water,
    new THREE.MeshStandardMaterial({
      color: 0x4d6f78,
      roughness: 0.08,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
  stream.name = 'river-stream';
  group.add(lakeWater());
  stream.receiveShadow = true;
  stream.matrixAutoUpdate = false;
  group.add(stream);
  return group;
}

/** The lake's water: an ellipse at its level (the shore's terrain rises through its edge). */
function lakeWater(): THREE.Mesh {
  const g = new GeoBuilder();
  const up = { x: 0, y: 1, z: 0 };
  const y = LAKE.level;
  const at = (i: number) => {
    const a = (i / 72) * Math.PI * 2;
    return { x: LAKE.x + Math.cos(a) * LAKE.rx, y, z: LAKE.z + Math.sin(a) * LAKE.rz };
  };
  const c = { x: LAKE.x, y, z: LAKE.z };
  for (let i = 0; i < 72; i += 1) {
    const [a, b] = [at(i), at(i + 1)];
    g.tri(c, b, a, up, [c.x / 8, c.z / 8, b.x / 8, b.z / 8, a.x / 8, a.z / 8]);
  }
  const mesh = new THREE.Mesh(
    g.build(),
    new THREE.MeshStandardMaterial({ color: 0x2f6c78, roughness: 0.1, metalness: 0.05 }),
  );
  mesh.name = 'lake';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
