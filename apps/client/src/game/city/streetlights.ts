/**
 * Cobra-head street lights along every sidewalk. At night the heads glow and each casts a
 * warm pool of light on the street: a soft additive decal instead of a real light, so a few
 * hundred lamps cost two draw calls rather than hundreds of shadowless point lights.
 */
import type { StreetLight } from '@fr33world/city';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Tier } from '../quality.ts';
import { byTile, setInstanceReach, tileGroup } from './tiles.ts';

const POLE_HEIGHT = 8.6;
const ARM_LENGTH = 2.6;

/** How far lamps are drawn per tier (m): thin poles vanish into the distance quickly. */
const LAMP_DISTANCE: Record<Tier, number> = { low: 250, medium: 350, high: 450, ultra: 600 };

export function buildStreetLights(lights: StreetLight[], tier: Tier) {
  const reach = LAMP_DISTANCE[tier];
  const group = new THREE.Group();
  group.name = 'street-lights';

  const pole = new THREE.CylinderGeometry(0.08, 0.13, POLE_HEIGHT, 8);
  pole.translate(0, POLE_HEIGHT / 2, 0);
  const arm = new THREE.BoxGeometry(ARM_LENGTH, 0.09, 0.09);
  arm.translate(ARM_LENGTH / 2, POLE_HEIGHT - 0.15, 0);
  const base = new THREE.CylinderGeometry(0.22, 0.26, 0.6, 8);
  base.translate(0, 0.3, 0);
  const frame = mergeGeometries([pole, arm, base]);
  const head = new THREE.BoxGeometry(0.75, 0.16, 0.34);
  head.translate(ARM_LENGTH, POLE_HEIGHT - 0.2, 0);
  const pool = new THREE.PlaneGeometry(20, 20);
  pool.rotateX(-Math.PI / 2);

  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x7c8086,
    roughness: 0.55,
    metalness: 0.6,
  });
  const headMaterial = new THREE.MeshStandardMaterial({
    color: 0x9a9a96,
    roughness: 0.4,
    metalness: 0.3,
    emissive: 0xffd7a0,
    emissiveIntensity: 0,
  });
  const poolMaterial = new THREE.MeshBasicMaterial({
    map: lightPoolTexture(),
    color: 0xffc98a,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(1, 0, 0);
  const hillPool = new THREE.Vector3(0.65, 1, 0.65);
  const tilt = new THREE.Quaternion();
  const pools: THREE.InstancedMesh[] = [];
  // One small instanced set per 400 m tile (tiles.ts), sharing geometry and materials.
  for (const tile of byTile(lights)) {
    const tileRoot = tileGroup(tile, reach);
    const frames = new THREE.InstancedMesh(frame, frameMaterial, tile.length);
    const heads = new THREE.InstancedMesh(head, headMaterial, tile.length);
    const tilePools = new THREE.InstancedMesh(pool, poolMaterial, tile.length);
    tile.forEach((l, i) => {
      // Local +x is the arm; turn it to point along the light's yaw (0 = +z).
      q.setFromAxisAngle(up, l.yaw - Math.PI / 2);
      const y = l.y ?? 0;
      m.compose(new THREE.Vector3(l.x, y + 0.15, l.z), q, one);
      frames.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      // The pool lies on the road: on a hill road, tilted to its grade (local z runs along it)
      // and smaller (a bank beside the road would cut through a wide one).
      tilt.setFromAxisAngle(right, -Math.atan(l.grade ?? 0));
      const reachOut = ARM_LENGTH - 0.4;
      m.compose(
        new THREE.Vector3(
          l.x + Math.sin(l.yaw) * reachOut,
          y + (l.y === undefined ? 0.03 : 0.07),
          l.z + Math.cos(l.yaw) * reachOut,
        ),
        q.clone().multiply(tilt),
        l.y === undefined ? one : hillPool,
      );
      tilePools.setMatrixAt(i, m);
    });
    frames.castShadow = true;
    for (const mesh of [frames, heads, tilePools]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      setInstanceReach(tileRoot, mesh, reach);
      tileRoot.add(mesh);
    }
    tilePools.renderOrder = 2;
    pools.push(tilePools);
    group.add(tileRoot);
  }

  return {
    group,
    update(night: number) {
      headMaterial.emissiveIntensity = night * 3.5;
      poolMaterial.opacity = night * 0.85;
      for (const p of pools) p.visible = night > 0.02;
    },
  };
}

function lightPoolTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
