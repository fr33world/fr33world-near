/**
 * Bus shelters (placements.ts `shelterSpots`): a steel frame with a glass back and end, a
 * roof, a bench inside, an advertising panel at the other end (original ads, painted on a
 * canvas at start-up, lit at night) and a bus-stop sign on a pole by the kerb. Built once in
 * its own frame (front open to +z) and drawn instanced per tile.
 */
import { hash2, type CityLayout } from '@fr33world/city';
import * as THREE from 'three';
import type { Tier } from '../quality.ts';
import { GeoBuilder } from './geo.ts';
import { SHELTER, shelterSpots } from './placements.ts';
import { byTile, tileGroup } from './tiles.ts';

const SLAB_Y = 0.15;
const DISTANCE: Record<Tier, number> = { low: 160, medium: 240, high: 320, ultra: 450 };

/** Original ads for Los Soles (no real brands): headline, line, colours. */
const ADS: [string, string, string, string][] = [
  ['RIDE THE', 'BUS LINE', '#0f6e8c', '#ffd23f'],
  ['GOLDEN COAST', 'DONUTS', '#f2a516', '#5a2a0c'],
  ['PACIFIC', 'DENTAL', '#ffffff', '#1d6fb8'],
  ['CYPRESS', 'COFFEE', '#2c4a2a', '#f3e6c8'],
];

/** One canvas: the ads side by side (portrait), then the bus-stop sign in the last strip. */
function atlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  ADS.forEach(([a, b, bg, fg], i) => {
    const x = i * 256;
    ctx.fillStyle = bg;
    ctx.fillRect(x, 0, 256, 512);
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(x + 128, 300, 86, 0, Math.PI * 2);
    ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.font = `900 34px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillText(a, x + 128, 120, 236);
    ctx.font = `900 46px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillText(b, x + 128, 175, 236);
  });
  // The bus-stop sign: a blue plate with a bus and BUS STOP.
  const x = 1024;
  ctx.fillStyle = '#1559a8';
  ctx.fillRect(x, 0, 256, 256);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + 60, 50, 136, 80);
  ctx.fillStyle = '#1559a8';
  ctx.fillRect(x + 72, 62, 50, 30);
  ctx.fillRect(x + 134, 62, 50, 30);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x + 88, 138, 12, 0, Math.PI * 2);
  ctx.arc(x + 168, 138, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.font = `900 44px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.fillText('BUS STOP', x + 128, 215, 236);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A vertical rectangle facing ±x or ±z with its texture the right way round from the front. */
function panel(
  g: GeoBuilder,
  c: THREE.Vector3Like,
  w: number,
  h: number,
  face: [number, number],
  uv: [number, number, number, number],
) {
  const [fx, fz] = face;
  const [rx, rz] = [fz, -fx];
  const p = (s: number, t: number) => ({
    x: c.x + rx * s * (w / 2),
    y: c.y + t * (h / 2),
    z: c.z + rz * s * (w / 2),
  });
  const [u0, v0, u1, v1] = uv;
  g.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), { x: fx, y: 0, z: fz }, [
    u0,
    v0,
    u1,
    v0,
    u1,
    v1,
    u0,
    v1,
  ]);
}

export function buildShelters(city: CityLayout, tier: Tier) {
  const group = new THREE.Group();
  group.name = 'bus-shelters';
  const spots = shelterSpots(city);
  const { w, d, h } = SHELTER;
  const [x1, z0, z1] = [w / 2, -d / 2, d / 2];
  const y0 = SLAB_Y;

  const metal = new GeoBuilder();
  for (const [px, pz] of [
    [-x1 + 0.05, z0 + 0.05],
    [x1 - 0.05, z0 + 0.05],
    [-x1 + 0.05, z1 - 0.15],
    [x1 - 0.05, z1 - 0.15],
  ] as const)
    metal.box(px - 0.05, y0, pz - 0.05, px + 0.05, y0 + h, pz + 0.05, 1);
  metal.box(-x1 - 0.15, y0 + h, z0 - 0.1, x1 + 0.15, y0 + h + 0.12, z1 + 0.35, 1);
  // The bench, and the bus-stop sign's pole by the kerb.
  metal.box(-1.4, y0 + 0.42, z0 + 0.2, 1.1, y0 + 0.48, z0 + 0.62, 1);
  metal.box(-1.3, y0, z0 + 0.35, -1.2, y0 + 0.42, z0 + 0.45, 1);
  metal.box(1.0, y0, z0 + 0.35, 1.1, y0 + 0.42, z0 + 0.45, 1);
  metal.box(x1 + 1.15, y0, z1 + 0.7, x1 + 1.23, y0 + 3.1, z1 + 0.78, 1);

  const glass = new GeoBuilder();
  glass.box(-x1 + 0.1, y0 + 0.25, z0 - 0.01, x1 - 0.1, y0 + h - 0.1, z0 + 0.01, 1);
  glass.box(-x1 - 0.01, y0 + 0.25, z0 + 0.1, -x1 + 0.01, y0 + h - 0.1, z1 - 0.25, 1);

  // The ad panel at the right-hand end (both faces), one geometry per ad; the sign's plate.
  const adGeometry = ADS.map((_, i) => {
    const g = new GeoBuilder();
    const c = new THREE.Vector3(x1 - 0.05, y0 + 1.35, (z0 + z1) / 2 - 0.1);
    const uv: [number, number, number, number] = [(i * 256) / 1280, 0, ((i + 1) * 256) / 1280, 1];
    panel(g, c.clone().setX(x1 + 0.05), d - 0.45, 2.0, [1, 0], uv);
    panel(g, c.clone().setX(x1 - 0.15), d - 0.45, 2.0, [-1, 0], uv);
    const sign = new THREE.Vector3(x1 + 1.19, y0 + 2.75, z1 + 0.74);
    const plate: [number, number, number, number] = [1024 / 1280, 0.5, 1, 1];
    panel(g, sign.clone().setZ(sign.z + 0.05), 0.6, 0.6, [0, 1], plate);
    panel(g, sign.clone().setZ(sign.z - 0.05), 0.6, 0.6, [0, -1], plate);
    return g.build();
  });
  const frameBox = new GeoBuilder();
  frameBox.box(x1 - 0.14, y0 + 0.3, z0 + 0.12, x1 + 0.04, y0 + 2.4, z1 - 0.28, 1);

  const texture = atlas();
  const adMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.4,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const materials = {
    metal: new THREE.MeshStandardMaterial({ color: 0x5d6670, roughness: 0.45, metalness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0xbfd8e2,
      roughness: 0.05,
      metalness: 0.1,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }),
  };
  const geometries = { metal: metal.build(), glass: glass.build(), frame: frameBox.build() };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  for (const tile of byTile(spots)) {
    const root = tileGroup(tile, DISTANCE[tier]);
    const place = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      list: typeof tile,
      cast: boolean,
    ) => {
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      list.forEach((s, i) => {
        q.setFromAxisAngle(up, s.yaw);
        m.compose(new THREE.Vector3(s.x, 0, s.z), q, one);
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      root.add(mesh);
    };
    place(geometries.metal, materials.metal, tile, true);
    place(geometries.frame, materials.metal, tile, true);
    place(geometries.glass, materials.glass, tile, false);
    adGeometry.forEach((g, i) =>
      place(
        g,
        adMaterial,
        tile.filter((s) => hash2(Math.round(s.x), Math.round(s.z)) % ADS.length === i),
        false,
      ),
    );
    group.add(root);
  }
  return {
    group,
    update(night: number) {
      adMaterial.emissiveIntensity = night * 0.9;
    },
  };
}
