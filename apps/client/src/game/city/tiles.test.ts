import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { setInstanceReach, tileGroup, updateTiles } from './tiles.ts';

/** A tile of instances along x at these positions, reaching 100 m. */
function tile(xs: number[]) {
  const root = new THREE.Group();
  const group = tileGroup(
    xs.map((x) => ({ x, z: 10 })),
    100,
  );
  const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, xs.length);
  xs.forEach((x, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, 10)));
  setInstanceReach(group, mesh, 100);
  root.add(group);
  return { root, mesh };
}

const drawn = (mesh: THREE.InstancedMesh) =>
  Array.from({ length: mesh.count }, (_, i) => {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(i, m);
    return m.elements[12];
  });

describe('instance reach', () => {
  it('draws only the instances within reach, not the whole tile', () => {
    const { root, mesh } = tile([20, 90, 150, 390]);
    updateTiles(root, new THREE.Vector3(10, 2, 10));
    expect(drawn(mesh)).toEqual([20, 90]);
  });

  it('follows the eye, and brings back instances it dropped', () => {
    const { root, mesh } = tile([20, 90, 150, 390]);
    updateTiles(root, new THREE.Vector3(10, 2, 10));
    updateTiles(root, new THREE.Vector3(200, 2, 10));
    expect(drawn(mesh)).toEqual([150]);
    updateTiles(root, new THREE.Vector3(10, 2, 10));
    expect(drawn(mesh)).toEqual([20, 90]);
  });

  it('waits until the eye has moved before sorting again', () => {
    const { root, mesh } = tile([20, 111]);
    updateTiles(root, new THREE.Vector3(10, 2, 10));
    const version = mesh.instanceMatrix.version;
    updateTiles(root, new THREE.Vector3(12, 2, 10));
    expect(mesh.instanceMatrix.version).toBe(version);
    expect(drawn(mesh)).toEqual([20]);
  });

  it('leaves a hidden tile alone', () => {
    const { root, mesh } = tile([20, 90]);
    updateTiles(root, new THREE.Vector3(1000, 2, 1000));
    expect(mesh.count).toBe(2);
  });
});
