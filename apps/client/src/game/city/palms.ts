/**
 * Los Soles' signature tall fan palms (Washingtonia-style): a tapered, slightly leaning bark
 * trunk and a crown of fan leaves on short stalks, upper leaves raised and lower ones drooping.
 * All palms are two instanced meshes. The fan leaf is painted into a canvas at start-up.
 */
import type { Palm } from '@fr33world/city';
import { rng } from '@fr33world/city';
import * as THREE from 'three';
import type { Textures } from '../materials.ts';
import type { Quality } from '../quality.ts';
import { byTile, setTileLod, tileGroup } from './tiles.ts';

const GROUND_Y = 0.15;

export function buildPalms(palms: Palm[], textures: Textures, quality: Quality): THREE.Group {
  const group = new THREE.Group();
  group.name = 'palms';
  if (palms.length === 0) return group;

  const trunkMaterial = new THREE.MeshStandardMaterial({
    map: textures.get('palm_bark_color.webp', true, [2, 9]),
    color: 0xb8a58c,
    roughness: 0.95,
  });
  const low = quality.tier === 'low';
  const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.3, 1, low ? 6 : 10, low ? 2 : 6, true);
  trunkGeometry.translate(0, 0.5, 0);

  const leafMaterial = new THREE.MeshStandardMaterial({
    map: fanLeafTexture(),
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    roughness: 0.75,
    color: 0x9fb87a,
    vertexColors: true,
  });
  const crownGeometry = fanCrown(low ? 11 : 30);
  // The light version for distant tiles: a handful of leaves on a plain trunk.
  const farCrownGeometry = fanCrown(7);
  const farTrunkGeometry = new THREE.CylinderGeometry(0.16, 0.3, 1, 5, 1, true);
  farTrunkGeometry.translate(0, 0.5, 0);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const top = new THREE.Vector3();
  // One small instanced pair per 400 m tile (tiles.ts), sharing geometry and materials.
  const reach = PALM_DISTANCE[quality.tier];
  for (const tile of byTile(palms)) {
    const tileRoot = tileGroup(tile, reach);
    const trunkMatrices: THREE.Matrix4[] = [];
    const crownMatrices: THREE.Matrix4[] = [];
    for (const p of tile) {
      const r = rng(p.seed);
      const lean = r.range(0, 0.06);
      const leanDir = r.range(0, Math.PI * 2);
      e.set(Math.cos(leanDir) * lean, 0, Math.sin(leanDir) * lean);
      q.setFromEuler(e);
      const girth = r.range(0.85, 1.15);
      m.compose(
        new THREE.Vector3(p.x, GROUND_Y, p.z),
        q,
        new THREE.Vector3(girth, p.height, girth),
      );
      trunkMatrices.push(m.clone());
      top.set(0, 1, 0).applyMatrix4(m);
      const crownScale = (p.height > 17 ? 1.05 : 1.3) * r.range(0.85, 1.15);
      q.setFromEuler(e.set(0, r.range(0, Math.PI * 2), 0));
      m.compose(top, q, new THREE.Vector3(crownScale, crownScale, crownScale));
      crownMatrices.push(m.clone());
    }
    const level = (
      trunkGeo: THREE.BufferGeometry,
      crownGeo: THREE.BufferGeometry,
      shadows: boolean,
    ) => {
      const g = new THREE.Group();
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMaterial, tile.length);
      const crowns = new THREE.InstancedMesh(crownGeo, leafMaterial, tile.length);
      trunkMatrices.forEach((mat, i) => trunks.setMatrixAt(i, mat));
      crownMatrices.forEach((mat, i) => crowns.setMatrixAt(i, mat));
      for (const mesh of [trunks, crowns]) {
        mesh.castShadow = shadows;
        mesh.receiveShadow = shadows;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        g.add(mesh);
      }
      return g;
    };
    const near = level(trunkGeometry, crownGeometry, true);
    // Distant palms are beyond the shadow area anyway.
    const far = level(farTrunkGeometry, farCrownGeometry, false);
    tileRoot.add(near, far);
    setTileLod(tileRoot, near, far, PALM_DETAIL_DISTANCE);
    group.add(tileRoot);
  }
  return group;
}

/** Tiles closer than this (m, from the tile's edge) get the detailed palms. */
const PALM_DETAIL_DISTANCE = 120;

/** How far palms are drawn per tier (m): they make the skyline, so further than lamps. */
const PALM_DISTANCE: Record<Quality['tier'], number> = {
  low: 450,
  medium: 700,
  high: 1000,
  ultra: 1400,
};

/**
 * Crown of `count` fan leaves spiralling round the trunk top (golden-angle spacing), from
 * upright young leaves to drooping old ones, plus a few dead brown leaves hanging below. Each
 * blade is folded along its midrib and rolled about its stalk so the crown reads as a dense,
 * ragged ball rather than flat plates. Vertex colours tint the dead leaves.
 */
function fanCrown(count: number): THREE.BufferGeometry {
  const r = rng(0xfa9);
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const total = count + Math.round(count / 4);
  for (let i = 0; i < total; i += 1) {
    const dead = i >= count;
    const t = dead ? 1 : i / (count - 1);
    const azimuth = i * 2.39996 + r.range(-0.2, 0.2);
    const pitch = dead
      ? r.range(-1.45, -1.2)
      : THREE.MathUtils.lerp(1.25, -0.75, t) + r.range(-0.18, 0.18);
    const petiole = (dead ? 0.5 : THREE.MathUtils.lerp(0.7, 1.25, t)) * r.range(0.9, 1.1);
    const length = (dead ? 1.1 : 1.45) * r.range(0.85, 1.1);
    const width = (dead ? 0.9 : 2.1) * r.range(0.85, 1.1);

    const out = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const dir = out.clone().multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)).normalize();
    let side = new THREE.Vector3().crossVectors(up, dir);
    if (side.lengthSq() < 1e-4) side = new THREE.Vector3(1, 0, 0);
    side.normalize();
    // Roll the blade about its stalk, then fold it along the midrib.
    const normal0 = new THREE.Vector3().crossVectors(dir, side).normalize();
    const roll = r.range(-0.7, 0.7);
    const sideR = side
      .clone()
      .multiplyScalar(Math.cos(roll))
      .addScaledVector(normal0, Math.sin(roll));
    const normal = new THREE.Vector3().crossVectors(dir, sideR).normalize();
    const fold = width * 0.18;

    const base = dir.clone().multiplyScalar(petiole);
    const droop = new THREE.Vector3(0, dead ? -0.2 : -0.6, 0);
    const midDir = dir.clone().addScaledVector(droop, 0.4).normalize();
    const tipDir = dir.clone().add(droop).normalize();
    const mid = base.clone().addScaledVector(midDir, length * 0.5);
    const tip = mid.clone().addScaledVector(tipDir, length * 0.5);
    const w = width / 2;
    const tint = dead ? [0.62, 0.5, 0.34] : [1, 1, 1];

    const start = positions.length / 3;
    // Rows: base (narrow), middle, tip; columns: left edge, midrib (raised), right edge.
    const rows: [THREE.Vector3, number, number][] = [
      [base, 0.12, 0],
      [mid, 0.85, 0.5],
      [tip, 1, 1],
    ];
    for (const [centre, spread, v] of rows) {
      for (const [k, u] of [
        [-1, 0],
        [0, 0.5],
        [1, 1],
      ] as const) {
        const p = centre.clone().addScaledVector(sideR, k * w * spread);
        if (k === 0) p.addScaledVector(normal, fold * spread);
        positions.push(p.x, p.y, p.z);
        uvs.push(0.5 + (u - 0.5) * spread, v);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(...tint);
      }
    }
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 2; col += 1) {
        const a = start + row * 3 + col;
        index.push(a, a + 1, a + 4, a, a + 4, a + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  return g;
}

/** A fan leaf: leaflets radiating from the stalk, painted with soft colour variation. */
function fanLeafTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const r = rng(0x1eaf);
  const cx = size / 2;
  const cy = 0;
  const leaflets = 46;
  for (let i = 0; i < leaflets; i += 1) {
    const a = Math.PI * (0.08 + 0.84 * (i / (leaflets - 1))) + r.range(-0.02, 0.02);
    const len = size * r.range(0.82, 0.98);
    const width = r.range(0.022, 0.03);
    const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    const base = r.range(0, 1);
    g.addColorStop(0, `rgb(${70 + base * 20}, ${92 + base * 20}, 44)`);
    g.addColorStop(0.7, `rgb(${92 + base * 30}, ${122 + base * 25}, 58)`);
    g.addColorStop(1, `rgb(${150 + base * 40}, ${150 + base * 20}, 80)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a - width) * len * 0.92, cy + Math.sin(a - width) * len * 0.92);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.lineTo(cx + Math.cos(a + width) * len * 0.92, cy + Math.sin(a + width) * len * 0.92);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
