/**
 * The local player on foot: a Rapier kinematic capsule driven by input relative to the camera,
 * with gravity, jumping, autostep over curbs and snapping down them. The client owns this
 * body (decision D-05); the world server validates what it reports.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { MODE } from '@fr33world/protocol';
import { SPEED } from '@fr33world/shared';
import * as THREE from 'three';
import { moveAngle } from './character/animator.ts';
import { type Character, FOOT_LIFT } from './character/character.ts';
import type { Input } from './input.ts';
import { PHYSICS_DT, type Physics } from './physics.ts';

const CAPSULE_HALF = 0.55;
const CAPSULE_RADIUS = 0.3;
/** Feet to capsule centre. */
const CENTRE_Y = CAPSULE_HALF + CAPSULE_RADIUS;
/** Under the server's RUN limit, with headroom for its tolerance. */
const RUN_SPEED = SPEED.RUN * 0.92;
const WALK_SPEED = 1.6;
const JUMP_SPEED = 5.4;
const ACCEL_GROUND = 14;
const ACCEL_AIR = 3;
/** Off the ground this long (s) before the pose counts as falling (kerbs, seams). */
const COYOTE_S = 0.15;
const TURN_RATE = 12;

export class LocalPlayer {
  readonly position = new THREE.Vector3();
  /** Pose before the latest physics step (for drawing between steps). */
  private readonly prevPos = new THREE.Vector3();
  private prevYaw = 0;
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  grounded = true;
  /** MODE.* for the network and the animator. */
  mode: number = MODE.IDLE;
  gait: 'walk' | 'run' = 'run';
  /** Time off the ground (s), and on the ground as the pose sees it (see step). */
  private airTime = 0;
  private onGround = true;
  character: Character | null = null;
  /** While aiming a weapon the body faces this heading instead of where it moves. */
  faceYaw: number | null = null;
  readonly body: RAPIER.RigidBody;

  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly physics: Physics;
  private enabled = true;

  constructor(physics: Physics, spawn: { x: number; y: number; z: number; yaw: number }) {
    this.physics = physics;
    const { rapier, world } = physics;
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.x,
        spawn.y + CENTRE_Y,
        spawn.z,
      ),
    );
    this.collider = world.createCollider(
      rapier.ColliderDesc.capsule(CAPSULE_HALF, CAPSULE_RADIUS),
      this.body,
    );
    this.controller = world.createCharacterController(0.03);
    this.controller.enableAutostep(0.4, 0.15, false);
    this.controller.enableSnapToGround(0.45);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((40 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.position.set(spawn.x, spawn.y, spawn.z);
    this.yaw = spawn.yaw;
    this.prevPos.copy(this.position);
    this.prevYaw = this.yaw;
  }

  /** Teleports the body (spawn, server correction, leaving a car). */
  place(x: number, y: number, z: number, yaw?: number): void {
    this.body.setTranslation({ x, y: y + CENTRE_Y, z }, true);
    this.body.setNextKinematicTranslation({ x, y: y + CENTRE_Y, z });
    this.position.set(x, y, z);
    // A teleport, not a move: don't draw a smear between the two places.
    this.prevPos.set(x, y, z);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
  }

  /** Takes the capsule out of the world while seated in a car (and back). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.collider.setEnabled(on);
    if (this.character) this.character.root.visible = on;
  }

  /** One fixed physics step of movement. `cameraYaw` orients the input. */
  step(input: Input, cameraYaw: number, jump: boolean): void {
    if (!this.enabled) return;
    // Where the body is before this physics step, for drawing between steps (sync).
    const t0 = this.body.translation();
    this.prevPos.set(t0.x, t0.y - CENTRE_Y, t0.z);
    this.prevYaw = this.yaw;
    const dt = PHYSICS_DT;
    // Camera-relative intent: forward is where the camera looks, flattened.
    const fx = Math.sin(cameraYaw);
    const fz = Math.cos(cameraYaw);
    const wantX = fx * input.move.y - fz * input.move.x;
    const wantZ = fz * input.move.y + fx * input.move.x;
    const amount = Math.min(1, Math.hypot(input.move.x, input.move.y));
    this.gait = input.walk ? 'walk' : 'run';
    const top = input.walk ? WALK_SPEED * Math.max(amount, 0.6) : RUN_SPEED * amount;
    const len = Math.hypot(wantX, wantZ) || 1;
    const targetX = (wantX / len) * top;
    const targetZ = (wantZ / len) * top;

    const accel = (this.grounded ? ACCEL_GROUND : ACCEL_AIR) * dt;
    this.velocity.x += THREE.MathUtils.clamp(
      targetX - this.velocity.x,
      -accel * RUN_SPEED,
      accel * RUN_SPEED,
    );
    this.velocity.z += THREE.MathUtils.clamp(
      targetZ - this.velocity.z,
      -accel * RUN_SPEED,
      accel * RUN_SPEED,
    );
    if (this.grounded) {
      this.velocity.y = jump ? JUMP_SPEED : -1;
    } else {
      this.velocity.y -= 16 * dt;
    }

    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    this.controller.computeColliderMovement(this.collider, desired);
    let moved = this.controller.computedMovement();
    // On level paving the sweep, angled down at the ground, can stop dead for a step with
    // nothing in the way: the speed then dropped to nothing and the run flicked to idle (about
    // one step in sixteen). The same move kept level gets through; against a real wall it
    // doesn't, so walls still stop the body.
    const wanted = Math.hypot(desired.x, desired.z);
    if (
      this.controller.computedGrounded() &&
      !jump &&
      wanted > 1e-3 &&
      Math.hypot(moved.x, moved.z) < wanted * 0.2
    ) {
      this.controller.computeColliderMovement(this.collider, { ...desired, y: 0 });
      moved = this.controller.computedMovement();
    }
    const wasAirborne = !this.grounded;
    this.grounded = this.controller.computedGrounded();
    // The controller's grounded flag drops out for a step at kerbs, seams and small bumps;
    // counted as a fall, the run flicked towards the idle and back (a hitch every few steps).
    // So the pose only counts as airborne after a moment off the ground, or going up (a jump).
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    this.onGround = this.grounded || (this.airTime < COYOTE_S && this.velocity.y <= 0);
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + moved.x, y: t.y + moved.y, z: t.z + moved.z });
    // What we really moved is the velocity others see (walls stop us).
    this.velocity.x = moved.x / dt;
    this.velocity.z = moved.z / dt;
    if (this.grounded && wasAirborne) this.velocity.y = 0;
    if (!this.grounded && moved.y > desired.y + 1e-4 && this.velocity.y > 0) this.velocity.y = 0;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.faceYaw !== null) {
      let d = this.faceYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, TURN_RATE * 1.5 * dt);
    } else if (speed > 0.3) {
      const target = Math.atan2(this.velocity.x, this.velocity.z);
      let d = target - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, TURN_RATE * dt);
    }
    const before = this.mode;
    if (!this.onGround) this.mode = this.velocity.y > 0 ? MODE.JUMP : MODE.FALL;
    else if (speed < 0.3) this.mode = MODE.IDLE;
    else this.mode = this.gait === 'walk' ? MODE.WALK : MODE.RUN;
    // Just left the ground going up: the jump.
    if (this.mode === MODE.JUMP && before !== MODE.JUMP && before !== MODE.FALL)
      this.character?.animator?.jump();
  }

  /** After the physics step: read the body back and pose the character model. */
  /**
   * After the physics steps: `alpha` (0–1) is how far this frame is between the last two
   * steps, so the body is drawn that far along (smooth at any frame rate; physics runs at a
   * fixed 60 Hz).
   */
  sync(dt: number, alpha = 1): void {
    if (!this.enabled) return;
    const t = this.body.translation();
    this.position
      .set(t.x, t.y - CENTRE_Y, t.z)
      .sub(this.prevPos)
      .multiplyScalar(alpha)
      .add(this.prevPos);
    const c = this.character;
    if (!c) return;
    c.root.position.copy(this.position);
    c.root.position.y += FOOT_LIFT;
    let dy = this.yaw - this.prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    // All three axes: the seat in a car leaves its whole turn here (past 90° that reads as a
    // half turn on x and z), and yaw alone on top of it walked the body backwards.
    c.root.rotation.set(0, this.prevYaw + dy * alpha, 0);
    const speed = this.onGround ? Math.hypot(this.velocity.x, this.velocity.z) : 0;
    // Facing is locked (armed): the legs need to know which way we're really going.
    const angle =
      this.faceYaw !== null ? moveAngle(this.velocity.x, this.velocity.z, this.yaw) : undefined;
    c.update(dt, speed, this.gait, angle);
  }
}
