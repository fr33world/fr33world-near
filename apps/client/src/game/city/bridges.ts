/**
 * Bridges where the main roads cross the river channel (layout `bridges`): a concrete deck at
 * street level (the road and its markings are drawn by city.ts across it), raised sidewalks,
 * parapets, and on each face a concrete arch springing from the channel floor with columns up
 * to the deck, after the river's old viaducts. Physics matches in physics.ts.
 */
import { type Bridge, type CityLayout, RIVER_DEPTH, RIVER_FLOOR } from '@fr33world/city';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoBuilder } from './geo.ts';

const SLAB_Y = 0.15;
const DECK_BOTTOM = -1.4;
/** The arches' crown, just under the deck. */
const CROWN = DECK_BOTTOM - 0.2;

/** Height of a bridge's arch at x (a parabola from the channel floor's edges to the crown). */
export function archY(x: number): number {
  const mid = (RIVER_FLOOR.x0 + RIVER_FLOOR.x1) / 2;
  const half = (RIVER_FLOOR.x1 - RIVER_FLOOR.x0) / 2;
  const rise = -RIVER_DEPTH - CROWN;
  return CROWN + rise * ((x - mid) / half) ** 2;
}

/** The arch faces' depth offsets from the road centre (outside the parapets). */
export function archFaces(b: Bridge): number[] {
  return [b.z - b.half - 0.9, b.z + b.half + 0.9];
}

export function buildBridges(
  city: CityLayout,
  m: { concrete: THREE.Material; sidewalk: THREE.Material },
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'bridges';
  const deck = new GeoBuilder();
  const walks = new GeoBuilder();
  const arches: THREE.BufferGeometry[] = [];
  for (const b of city.bridges) {
    // The deck (its top is the road), sidewalks, and parapets with a coping.
    deck.box(b.x0, DECK_BOTTOM, b.z - b.half - 1.4, b.x1, -0.01, b.z + b.half + 1.4, 3, false);
    for (const side of [-1, 1]) {
      const [a, c] = [b.z + side * b.carriage, b.z + side * b.half];
      walks.box(b.x0, -0.02, Math.min(a, c), b.x1, SLAB_Y, Math.max(a, c), 3);
      const [p0, p1] = [b.z + side * b.half, b.z + side * (b.half + 0.4)];
      deck.box(b.x0, 0, Math.min(p0, p1), b.x1, 1.1, Math.max(p0, p1), 2);
      const [k0, k1] = [b.z + side * (b.half - 0.05), b.z + side * (b.half + 0.5)];
      deck.box(b.x0, 1.1, Math.min(k0, k1), b.x1, 1.25, Math.max(k0, k1), 2);
    }
    // Arches on both faces, with columns from the arch up to the deck.
    for (const z of archFaces(b)) {
      const SEGMENTS = 14;
      const x0 = RIVER_FLOOR.x0;
      const x1 = RIVER_FLOOR.x1;
      for (let i = 0; i < SEGMENTS; i += 1) {
        const xa = x0 + ((x1 - x0) * i) / SEGMENTS;
        const xb = x0 + ((x1 - x0) * (i + 1)) / SEGMENTS;
        arches.push(
          beam(new THREE.Vector3(xa, archY(xa), z), new THREE.Vector3(xb, archY(xb), z), 1.1),
        );
      }
      for (let x = x0 + 5.5; x < x1 - 3; x += 5.5) {
        arches.push(
          new THREE.BoxGeometry(0.6, DECK_BOTTOM - archY(x), 0.8).translate(
            x,
            (DECK_BOTTOM + archY(x)) / 2,
            z,
          ),
        );
      }
    }
  }
  for (const [builder, material, name] of [
    [deck, m.concrete, 'bridge-decks'],
    [walks, m.sidewalk, 'bridge-sidewalks'],
  ] as const) {
    if (builder.vertexCount === 0) continue;
    group.add(mesh(builder.build(), material, name));
  }
  if (arches.length > 0) group.add(mesh(mergeGeometries(arches), m.concrete, 'bridge-arches'));
  return group;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string) {
  const out = new THREE.Mesh(geometry, material);
  out.name = name;
  out.castShadow = true;
  out.receiveShadow = true;
  out.matrixAutoUpdate = false;
  return out;
}

/** A square beam from `a` to `b`. */
function beam(a: THREE.Vector3, b: THREE.Vector3, thickness: number): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const g = new THREE.BoxGeometry(thickness, dir.length() + thickness * 0.5, thickness);
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()),
  );
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}
