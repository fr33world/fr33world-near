import { handlingOf } from '@fr33world/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SEAT } from '../character/animator.ts';
import { seatCharacter } from './seating.ts';

describe('a driver in the seat', () => {
  const rest = 0.9;
  // A turned car, tilted nose-up on a hill.
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.15, 0.8, 0, 'YXZ'));
  const car = { pos: new THREE.Vector3(10, 2, -5), yaw: 0.8, quat, id: 'suv' };
  const [sx, sy, sz] = handlingOf('suv').seat;
  const seatHips = new THREE.Vector3(sx, sy, sz).applyQuaternion(quat).add(car.pos);

  /** Where the hips are, for a root placed by seatCharacter and hips at (x, y, z) in its frame. */
  const hipsAt = (phase: 'enter' | 'drive', x: number, z: number) => {
    const root = new THREE.Object3D();
    seatCharacter(root, car, phase, rest);
    root.updateMatrixWorld();
    return new THREE.Vector3(x, SEAT.driving * rest, z).applyMatrix4(root.matrixWorld);
  };

  it('at the wheel: hips on the seat, facing the car’s way', () => {
    expect(hipsAt('drive', 0, 0).distanceTo(seatHips)).toBeLessThan(1e-6);
  });

  it('getting in: the clip ends with its hips on the seat, facing forward', () => {
    const end = hipsAt('enter', SEAT.enterEnd.x * rest, SEAT.enterEnd.z * rest);
    expect(end.distanceTo(seatHips)).toBeLessThan(1e-6);
    // The clip's final facing (its own yaw enterEnd.yaw) comes out as the car's.
    const root = new THREE.Object3D();
    seatCharacter(root, car, 'enter', rest);
    const facing = new THREE.Vector3(
      Math.sin(SEAT.enterEnd.yaw),
      0,
      Math.cos(SEAT.enterEnd.yaw),
    ).applyQuaternion(root.quaternion);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    expect(facing.angleTo(forward)).toBeLessThan(1e-6);
  });
});
