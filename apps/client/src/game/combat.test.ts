import { WEAPON } from '@fr33world/protocol';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Combat } from './combat.ts';
import type { NetClient } from './net.ts';
import type { Physics } from './physics.ts';

/** A pistol in hand, looking down +z from eye height, with the first wall `wall` metres off. */
function aim(wall = Infinity) {
  const physics = { rayDistance: (_o: unknown, _d: unknown, max: number) => Math.min(wall, max) };
  const combat = new Combat(
    new THREE.Scene(),
    physics as unknown as Physics,
    {} as unknown as NetClient,
  );
  combat.show(WEAPON.HEAVY_PISTOL);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.5, 0);
  camera.lookAt(0, 1.5, 10);
  camera.updateMatrixWorld();
  return { combat, camera };
}

describe('the crosshair over a person', () => {
  it('turns red on someone in the line of fire', () => {
    const { combat, camera } = aim();
    expect(combat.onPerson(camera, null, [new THREE.Vector3(0, 0, 12)])).toBe(true);
  });

  it('stays white beside them, past the gun’s range, or behind the camera', () => {
    const { combat, camera } = aim();
    expect(combat.onPerson(camera, null, [new THREE.Vector3(1.5, 0, 12)])).toBe(false);
    expect(combat.onPerson(camera, null, [new THREE.Vector3(0, 0, 200)])).toBe(false);
    expect(combat.onPerson(camera, null, [new THREE.Vector3(0, 0, -5)])).toBe(false);
  });

  it('stays white with a wall in the way, so it gives nobody away', () => {
    const { combat, camera } = aim(6);
    expect(combat.onPerson(camera, null, [new THREE.Vector3(0, 0, 12)])).toBe(false);
  });

  it('goes by the nearest of several', () => {
    const { combat, camera } = aim(8);
    expect(
      combat.onPerson(camera, null, [new THREE.Vector3(0, 0, 40), new THREE.Vector3(0, 0, 5)]),
    ).toBe(true);
  });
});
