/**
 * Flowering trees (placements.ts `treeSpots`): jacarandas in purple bloom (Los Soles' spring,
 * as on LA's streets) and white-blossom trees. A short bark trunk forks into three or four
 * branches under a canopy of lumpy puffs, a jacaranda's broad and flat like an umbrella, a
 * blossom tree's rounder. The canopies wear a blossom texture painted at start-up (petals over
 * leaves, nothing to download); under each jacaranda lies a mat of fallen purple petals.
 * Instanced per 400 m tile like the palms, with a light version for distant tiles.
 */
import { rng } from '@fr33world/city';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Textures } from '../materials.ts';
import type { Quality } from '../quality.ts';
import type { TreeSpot } from './placements.ts';
import { byTile, setTileLod, tileGroup } from './tiles.ts';

/** How far trees are drawn per tier (m), and the distance their detailed version reaches. */
const DISTANCE: Record<Quality['tier'], number> = { low: 300, medium: 450, high: 650, ultra: 900 };
const DETAIL = 160;

type Species = TreeSpot['species'];

/** A cylinder from a to b, radius r0 at a and r1 at b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, sides: number) {
  const dir = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r1, r0, dir.length(), sides, 1, true);
  g.translate(0, dir.length() / 2, 0);
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()),
  );
  g.translate(a.x, a.y, a.z);
  return g;
}

/** The trunk and its main branches; the tips (where the canopy puffs sit) are returned too. */
function skeleton(species: Species, sides: number) {
  const r = rng(species === 'jacaranda' ? 0x1ac : 0xb10);
  const fork = new THREE.Vector3(0, species === 'jacaranda' ? 2.6 : 2.2, 0);
  const parts = [limb(new THREE.Vector3(0, -0.2, 0), fork, 0.24, 0.17, sides)];
  const tips: THREE.Vector3[] = [];
  const n = species === 'jacaranda' ? 4 : 3;
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
    const spread = species === 'jacaranda' ? r.range(2.4, 3.2) : r.range(1.6, 2.2);
    const tip = new THREE.Vector3(
      Math.cos(a) * spread,
      fork.y + r.range(2.2, 3.0),
      Math.sin(a) * spread,
    );
    parts.push(limb(fork, tip, 0.13, 0.06, sides));
    tips.push(tip);
  }
  return { geometry: mergeGeometries(parts), tips };
}

/** Smooth-ish value noise for lumpy puffs. */
function lump(x: number, y: number, z: number) {
  return (
    Math.sin(x * 2.1 + y * 1.3) * 0.5 +
    Math.sin(y * 2.7 - z * 1.9) * 0.3 +
    Math.sin(z * 3.1 + x * 1.7) * 0.2
  );
}

/**
 * The canopy: puffs (displaced icosahedra) over the branch tips and between them, flattened
 * for a jacaranda; texture coordinates wrap each puff so the blossom texture covers it.
 */
function canopy(species: Species, tips: THREE.Vector3[], detail: number, extra: number) {
  const r = rng(species === 'jacaranda' ? 0xca1 : 0xca2);
  const flat = species === 'jacaranda' ? 0.62 : 0.85;
  const centres: [THREE.Vector3, number][] = tips.map((t) => [t.clone(), r.range(2.0, 2.5)]);
  for (let i = 0; i < extra; i += 1) {
    const a = r.range(0, Math.PI * 2);
    const d = r.range(0, species === 'jacaranda' ? 2.6 : 1.6);
    const y = (tips[0]?.y ?? 5) + r.range(0.2, 1.3);
    centres.push([new THREE.Vector3(Math.cos(a) * d, y, Math.sin(a) * d), r.range(1.7, 2.3)]);
  }
  const parts = centres.map(([c, size], k) => {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const uv: number[] = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i);
      const n = 1 + 0.18 * lump(v.x * 2 + k, v.y * 2, v.z * 2 - k);
      uv.push(Math.atan2(v.z, v.x) / Math.PI + 1, v.y * 0.5 + 0.5);
      pos.setXYZ(i, c.x + v.x * size * n, c.y + v.y * size * n * flat, c.z + v.z * size * n);
    }
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  });
  const merged = mergeGeometries(parts);
  // Normals pointing out from the canopy's middle light it as one soft mass, not lumps.
  const middle = new THREE.Vector3(0, (tips[0]?.y ?? 5) + 0.3, 0);
  const pos = merged.getAttribute('position') as THREE.BufferAttribute;
  const nor = merged.getAttribute('normal') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    p.fromBufferAttribute(pos, i).sub(middle).normalize();
    n.fromBufferAttribute(nor, i).lerp(p, 0.6).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  return merged;
}

/** Petals over leaves: a canvas of small dots, mostly the bloom's colour. */
function blossomTexture(species: Species): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const r = rng(species === 'jacaranda' ? 0x9e7 : 0x9e8);
  const [base, bloom, leaf] =
    species === 'jacaranda'
      ? ['#5f44b0', ['#7d5fd6', '#9474e6', '#6b4fc4', '#a98bf0'], ['#465f2c', '#55703a']]
      : [
          '#c9cdbd',
          ['#ffffff', '#f6eef2', '#fbf7f0', '#f3e1ea'],
          ['#567636', '#668641', '#4b6a2f'],
        ];
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const dots = (colours: string[], count: number, radius: [number, number]) => {
    for (let i = 0; i < count; i += 1) {
      ctx.fillStyle = r.pick(colours);
      ctx.beginPath();
      ctx.arc(r.range(0, size), r.range(0, size), r.range(radius[0], radius[1]), 0, Math.PI * 2);
      ctx.fill();
    }
  };
  dots(leaf, species === 'jacaranda' ? 300 : 1300, [2, 5]);
  dots(bloom, species === 'jacaranda' ? 2600 : 1500, [1.5, 3.5]);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  return tex;
}

/** The mat of fallen petals under a jacaranda: speckles fading out to the edge. */
function petalTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const r = rng(0x9e7a1);
  for (let i = 0; i < 900; i += 1) {
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.range(0, 1)) * (size / 2 - 2);
    ctx.globalAlpha = 0.85 * (1 - d / (size / 2));
    ctx.fillStyle = r.pick(['#8c6fe0', '#a58bf0', '#7a5fcf']);
    ctx.beginPath();
    ctx.arc(
      size / 2 + Math.cos(a) * d,
      size / 2 + Math.sin(a) * d,
      r.range(0.8, 1.8),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildTrees(
  trees: readonly TreeSpot[],
  textures: Textures,
  quality: Quality,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees';
  if (trees.length === 0) return group;
  const trunkMaterial = new THREE.MeshStandardMaterial({
    map: textures.get('palm_bark_color.webp', true, [1, 3]),
    color: 0x8a7a68,
    roughness: 0.95,
  });
  const low = quality.tier === 'low';
  const kinds = (['jacaranda', 'blossom'] as const).map((species) => {
    const near = skeleton(species, 7);
    const far = skeleton(species, 4);
    return {
      species,
      trunk: near.geometry,
      farTrunk: far.geometry,
      crown: canopy(species, near.tips, 1, low ? 2 : 5),
      farCrown: canopy(species, far.tips, 0, 1),
      material: new THREE.MeshStandardMaterial({ map: blossomTexture(species), roughness: 0.85 }),
    };
  });
  const petals = new THREE.MeshStandardMaterial({
    map: petalTexture(),
    transparent: true,
    depthWrite: false,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const petalGeometry = new THREE.CircleGeometry(4.5, 20).rotateX(-Math.PI / 2);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const tile of byTile(trees)) {
    const root = tileGroup(tile, DISTANCE[quality.tier]);
    const level = (detailed: boolean) => {
      const g = new THREE.Group();
      for (const kind of kinds) {
        const mine = tile.filter((t) => t.species === kind.species);
        if (mine.length === 0) continue;
        const trunks = new THREE.InstancedMesh(
          detailed ? kind.trunk : kind.farTrunk,
          trunkMaterial,
          mine.length,
        );
        const crowns = new THREE.InstancedMesh(
          detailed ? kind.crown : kind.farCrown,
          kind.material,
          mine.length,
        );
        mine.forEach((t, i) => {
          const r = rng(t.seed);
          q.setFromAxisAngle(up, r.range(0, Math.PI * 2));
          const s = t.size;
          m.compose(
            new THREE.Vector3(t.x, t.y, t.z),
            q,
            new THREE.Vector3(s * r.range(0.9, 1.1), s, s * r.range(0.9, 1.1)),
          );
          trunks.setMatrixAt(i, m);
          crowns.setMatrixAt(i, m);
        });
        for (const mesh of [trunks, crowns]) {
          mesh.castShadow = detailed;
          mesh.receiveShadow = detailed;
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          g.add(mesh);
        }
        if (detailed && kind.species === 'jacaranda') {
          const mats = new THREE.InstancedMesh(petalGeometry, petals, mine.length);
          mine.forEach((t, i) => {
            m.compose(
              new THREE.Vector3(t.x, t.y + 0.015, t.z),
              q.identity(),
              new THREE.Vector3(t.size, 1, t.size),
            );
            mats.setMatrixAt(i, m);
          });
          mats.receiveShadow = true;
          mats.renderOrder = 1;
          mats.instanceMatrix.needsUpdate = true;
          mats.computeBoundingSphere();
          g.add(mats);
        }
      }
      return g;
    };
    const near = level(true);
    const far = level(false);
    root.add(near, far);
    setTileLod(root, near, far, DETAIL);
    group.add(root);
  }
  return group;
}
