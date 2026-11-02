/**
 * Gardens (placements.ts `gardens`): flower beds of dark soil planted with low clumps of
 * flowers, one colour to a planting as bedding is planted (red, yellow, purple, pink, orange,
 * white), each a canvas of petals over leaves painted at start-up; and agaves, blue-green
 * rosettes of pointed leaves. Instanced per 400 m tile with a short draw distance; nothing here collides.
 */
import { rng } from '@fr33world/city';
import * as THREE from 'three';
import type { Tier } from '../quality.ts';
import { GeoBuilder } from './geo.ts';
import type { Gardens, PlantSpot } from './placements.ts';
import { byTile, setInstanceReach, TiledGeo, tileGroup } from './tiles.ts';

/** How far flowers and agaves are drawn per tier (m): they're small. */
const DISTANCE: Record<Tier, number> = { low: 90, medium: 140, high: 200, ultra: 280 };

/** The plantings: one colour each (as bedding is planted), two shades of its petals. */
const PLANTINGS: string[][] = [
  ['#d4142f', '#ff3048'],
  ['#ffc400', '#ffdb4d'],
  ['#8a2be2', '#a855f7'],
  ['#ff3f8f', '#ff79b2'],
  ['#ff6200', '#ff8c2e'],
  ['#ffffff', '#f1f1ec'],
];

/** A planting: petals over leaves. */
function flowerTexture(i: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const petals = PLANTINGS[i] as string[];
  const r = rng(0xf10 + i);
  ctx.fillStyle = '#2c5420';
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 200; k += 1) {
    ctx.fillStyle = r.pick(['#21451a', '#3c6b2b', '#4a7c33']);
    ctx.fillRect(r.range(0, size), r.range(0, size), r.range(2, 5), r.range(2, 5));
  }
  for (let k = 0; k < 230; k += 1) {
    // A flower: five petals round a centre.
    const [x, y] = [r.range(0, size), r.range(0, size)];
    const rad = r.range(2.2, 3.6);
    ctx.fillStyle = r.pick(petals);
    for (let p = 0; p < 5; p += 1) {
      const a = (p / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, rad * 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = i === 1 ? '#a8561a' : '#ffd84a';
    ctx.beginPath();
    ctx.arc(x, y, rad * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A low mound of flowers about 0.6 m across. */
function clump(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.32, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    pos.setXYZ(i, v.x, Math.max(-0.02, v.y * 0.6), v.z);
  }
  g.computeVertexNormals();
  // The lower half is under the soil, in every one of the thousand or so round a player.
  const above: number[] = [];
  for (let i = 0; i < pos.count; i += 3)
    if (Math.max(pos.getY(i), pos.getY(i + 1), pos.getY(i + 2)) > -0.015)
      above.push(i, i + 1, i + 2);
  g.setIndex(above);
  return g;
}

/** An agave: a rosette of pointed leaves, curving out and up, about 1.2 m across. */
function agave(): THREE.BufferGeometry {
  const g = new GeoBuilder().attribute('color', 3, [1, 1, 1]);
  const r = rng(0xa6a);
  const colour = new THREE.Color();
  const leaves = 16;
  for (let i = 0; i < leaves; i += 1) {
    const a = i * 2.39996;
    const inner = i < 6;
    const len = inner ? r.range(0.45, 0.6) : r.range(0.6, 0.75);
    const rise = inner ? 1.1 : r.range(0.45, 0.8);
    const [dx, dz] = [Math.cos(a), Math.sin(a)];
    const [sx, sz] = [-dz, dx];
    const w = 0.07;
    const base = new THREE.Vector3(dx * 0.04, 0.03, dz * 0.04);
    const mid = new THREE.Vector3(dx * len * 0.5, rise * len * 0.55, dz * len * 0.5);
    const tip = new THREE.Vector3(
      dx * len * Math.cos(rise * 0.6),
      Math.sin(rise) * len * 0.8,
      dz * len * Math.cos(rise * 0.6),
    );
    const n = new THREE.Vector3(-dx * Math.sin(rise), Math.cos(rise), -dz * Math.sin(rise));
    g.set('color', colour.setHex(inner ? 0x5f8a7e : 0x4c7569).toArray());
    const b0 = { x: base.x - sx * w, y: base.y, z: base.z - sz * w };
    const b1 = { x: base.x + sx * w, y: base.y, z: base.z + sz * w };
    const m0 = { x: mid.x - sx * w * 1.3, y: mid.y, z: mid.z - sz * w * 1.3 };
    const m1 = { x: mid.x + sx * w * 1.3, y: mid.y, z: mid.z + sz * w * 1.3 };
    g.quad(b0, b1, m1, m0, n, [0, 0, 1, 0, 1, 0.5, 0, 0.5]);
    g.set('color', colour.setHex(0x3a5a50).toArray());
    g.tri(m0, m1, tip, n, [0, 0.5, 1, 0.5, 0.5, 1]);
  }
  return g.build();
}

export function buildGardens(gardens: Gardens, tier: Tier): THREE.Group {
  const group = new THREE.Group();
  group.name = 'gardens';
  const reach = DISTANCE[tier];
  const flowerGeometry = clump();
  const flowerMaterials = PLANTINGS.map(
    (_, i) => new THREE.MeshStandardMaterial({ map: flowerTexture(i), roughness: 0.9 }),
  );
  const agaveGeometry = agave();
  const agaveMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const instanced = (
    spots: PlantSpot[],
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
  ) => {
    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    spots.forEach((s, i) => {
      q.setFromAxisAngle(up, s.yaw);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(s.size, s.size, s.size));
      mesh.setMatrixAt(i, m);
    });
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  };
  for (const tile of byTile(gardens.flowers)) {
    const root = tileGroup(tile, reach);
    flowerMaterials.forEach((material, mix) => {
      const mine = tile.filter((f) => f.mix === mix);
      if (mine.length === 0) return;
      const mesh = instanced(mine, flowerGeometry, material, 'flowers');
      setInstanceReach(root, mesh, reach);
      root.add(mesh);
    });
    group.add(root);
  }
  for (const tile of byTile(gardens.agaves)) {
    const root = tileGroup(tile, reach);
    const mesh = instanced(tile, agaveGeometry, agaveMaterial, 'agaves');
    mesh.castShadow = true;
    setInstanceReach(root, mesh, reach);
    root.add(mesh);
    group.add(root);
  }
  // The beds' soil, merged per tile.
  const soil = new TiledGeo(() => ({ soil: new GeoBuilder() }));
  for (const b of gardens.beds)
    soil.at((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2).soil.flat(b.x0, b.z0, b.x1, b.z1, b.y, 1);
  // (Its tiles go straight into the group, where the culling looks for them.)
  const beds = soil.build(
    {
      soil: {
        material: new THREE.MeshStandardMaterial({
          color: 0x3b2a1e,
          roughness: 1,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        }),
        name: 'flower-beds',
      },
    },
    reach,
    'flower-beds',
  );
  for (const tile of [...beds.children]) group.add(tile);
  return group;
}
