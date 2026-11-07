/**
 * Where a driver's character goes in a car (Phase 7: a visible driver): at the model's seat
 * (shared HANDLING), facing forward, at the wheel or getting out; or, getting in, placed so
 * the Getting-in clip ends in the seat (it turns a quarter and travels on the way). Tilted with
 * the car on a slope. The clips' measurements are the animator's SEAT.
 */
import { handlingOf, REAR_ROW } from '@fr33world/shared';
import * as THREE from 'three';
import { SEAT } from '../character/animator.ts';

/** A car as a driver sits in it: where (on the ground), its turn (and tilt), its model id. */
export interface SeatCar {
  pos: THREE.Vector3;
  yaw: number;
  /** The whole orientation, when the car tilts (the one being driven); else yaw alone. */
  quat?: THREE.Quaternion;
  id: string;
}

const UP = new THREE.Vector3(0, 1, 0);
const local = new THREE.Vector3();
const turn = new THREE.Quaternion();
const carQuat = new THREE.Quaternion();

/** Sets a driver's character `root` in `car`, for the move it's in. */
export function seatCharacter(
  root: THREE.Object3D,
  car: SeatCar,
  phase: 'enter' | 'drive' | 'exit',
  hipsRestY: number,
  /** 0 the driver; 1 beside them; 2 and 3 behind. */
  seat = 0,
): void {
  const [dx, sy, dz] = handlingOf(car.id).seat;
  const sx = seat % 2 === 1 ? -dx : dx;
  const sz = seat >= 2 ? dz - REAR_ROW : dz;
  if (car.quat) carQuat.copy(car.quat);
  else carQuat.setFromAxisAngle(UP, car.yaw);
  // In car space (+x its left, +z its front): the hips at the seat, the root under them.
  let turnBy = 0;
  local.set(sx, sy - SEAT.driving * hipsRestY, sz);
  if (phase === 'enter') {
    // The clip ends with its hips at enterEnd (in its own frame) facing enterEnd.yaw: turn and
    // shift its frame so that end is the seat, facing the car's way.
    turnBy = -SEAT.enterEnd.yaw;
    const ex = SEAT.enterEnd.x * hipsRestY;
    const ez = SEAT.enterEnd.z * hipsRestY;
    const c = Math.cos(turnBy);
    const s = Math.sin(turnBy);
    local.x -= ex * c + ez * s;
    local.z -= -ex * s + ez * c;
  }
  root.position.copy(local.applyQuaternion(carQuat)).add(car.pos);
  root.quaternion.copy(carQuat).multiply(turn.setFromAxisAngle(UP, turnBy));
}
