/**
 * Street props (placements.ts): Poly Haven models (scripts/assets/fetch-props.mjs: CC0, cut to
 * a phone's budget) drawn instanced, one small set per 400 m tile with a short draw distance
 * per tier. Each model's parts are merged into one geometry, centred on its footprint and
 * standing on y = 0. They stream in after the city: the group fills when the files arrive.
 */
import type { CityLayout, RoomProp } from '@fr33world/city';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadModel } from '../assets.ts';
import type { Tier } from '../quality.ts';
import { type PropKind, propSpots } from './placements.ts';
import { byTile, setInstanceReach, tileGroup } from './tiles.ts';

/** How far props are drawn per tier (m): they're small. */
const DISTANCE: Record<Tier, number> = { low: 120, medium: 180, high: 250, ultra: 350 };
/** Some models are smaller than the street needs (a window box as a street planter). */
const SCALE: Partial<Record<PropKind, number>> = { planter: 1.6 };

/** One geometry and material for a model: its parts merged, centred, standing on y = 0. */
export async function prepareProp(kind: PropKind | RoomProp['kind']) {
  const gltf = await loadModel(`props/${kind}.glb`, 200);
  gltf.scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone();
    // Only what every part has (some carry a second set of texture coordinates), as floats:
    // meshopt stores positions as normalised integers with the scale in the node, and
    // transforming them in place would clamp everything to ±1 m.
    for (const name of Object.keys(g.attributes)) {
      const a = g.getAttribute(name);
      if (!['position', 'normal', 'uv'].includes(name)) {
        g.deleteAttribute(name);
        continue;
      }
      const f = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i += 1)
        for (let k = 0; k < a.itemSize; k += 1) f[i * a.itemSize + k] = a.getComponent(i, k);
      g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
    }
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g.index ? g.toNonIndexed() : g);
    material ??= mesh.material as THREE.Material;
  });
  const geometry = mergeGeometries(parts);
  if (!geometry || !material) throw new Error(`props/${kind}.glb has no mesh`);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const s = SCALE[kind as PropKind] ?? 1;
  if (s !== 1) geometry.scale(s, s, s);
  geometry.computeBoundingSphere();
  return { geometry, material };
}

export function buildProps(city: CityLayout, tier: Tier): THREE.Group {
  const group = new THREE.Group();
  group.name = 'props';
  const spots = propSpots(city);
  const kinds = [...new Set(spots.map((s) => s.kind))];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  for (const kind of kinds) {
    prepareProp(kind).then(
      ({ geometry, material }) => {
        for (const tile of byTile(spots.filter((s) => s.kind === kind))) {
          const root = tileGroup(tile, DISTANCE[tier]);
          const mesh = new THREE.InstancedMesh(geometry, material, tile.length);
          tile.forEach((s, i) => {
            q.setFromAxisAngle(up, s.yaw);
            m.compose(new THREE.Vector3(s.x, s.y, s.z), q, one);
            mesh.setMatrixAt(i, m);
          });
          mesh.name = `props-${kind}`;
          mesh.castShadow = kind !== 'hydrant';
          mesh.receiveShadow = true;
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          setInstanceReach(root, mesh, DISTANCE[tier]);
          root.add(mesh);
          group.add(root);
        }
      },
      (e: unknown) => console.warn(`props: ${kind} failed to load`, e),
    );
  }
  return group;
}
