/**
 * The car the local player drives: a dynamic Rapier chassis with a raycast vehicle controller
 * (four wheels, front steering; front, rear or all-wheel drive). Each model handles its own way
 * (shared HANDLING: weight, grip, steering, brakes, springs, what it can do off the road).
 * Simulated only on the driver's device; everyone else sees its reported pose (decision
 * D-05), and the server bounds its speed.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { offRoadInHills, terrainHeight } from '@fr33world/city';
import { type Handling, handlingOf, SPEED } from '@fr33world/shared';
import * as THREE from 'three';
import { PHYSICS_DT, type Physics } from '../physics.ts';
import type { CarSpec } from './car-model.ts';

const SUSPENSION_REST = 0.32;
/** An average car's springs (a model's `springs` scales it). */
const SUSPENSION_STIFFNESS = 55;
/** The weight the engines in CAR_MODELS were tuned for (t): force scales with a car's own. */
const TUNED_MASS = 1.4;
/** Never report faster than the server will accept. */
const HARD_TOP_SPEED = SPEED.VEHICLE_MAX * 0.95;

export interface DriveInput {
  throttle: number;
  steer: number;
  brake: boolean;
  handbrake: boolean;
}

export class DrivenCar {
  readonly spec: CarSpec;
  readonly chassis: RAPIER.RigidBody;
  /** Ground-level position and heading, as sent to the server. */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  /** Chassis pose before the latest physics step, and after it (for interpolation). */
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly curQuat = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  /** Forward speed in m/s (negative when reversing). */
  speed = 0;
  steering = 0;
  braking = false;
  /** The engine's share of its power (shared enginePower: fuel and condition); 0 won't go. */
  power = 1;
  readonly handling: Handling;
  /**
   * Spring length at which a wheel sits at its modelled height (for posing wheel meshes):
   * the rest length less the static sag under the car's weight (gravity 16 m/s² over four
   * springs whose force scales with chassis mass).
   */
  readonly restLength: number;
  /** Its physics body is gone (dispose): stepping or reading it would crash Rapier. */
  private disposed = false;

  private readonly physics: Physics;
  private readonly controller: RAPIER.DynamicRayCastVehicleController;

  constructor(physics: Physics, spec: CarSpec, x: number, y: number, z: number, yaw: number) {
    this.physics = physics;
    this.spec = spec;
    const h = handlingOf(spec.id);
    this.handling = h;
    const stiffness = SUSPENSION_STIFFNESS * h.springs;
    const sag = 16 / (4 * stiffness);
    this.restLength = SUSPENSION_REST - sag;
    const { rapier, world } = physics;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.chassis = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(x, y + spec.centreY + 0.05, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.05)
        .setAngularDamping(1.2)
        .setCanSleep(false),
    );
    const [hx, hy, hz] = spec.half;
    // The model's weight, whatever the body size.
    const density = (h.mass * 1000) / (8 * hx * hy * hz);
    world.createCollider(
      rapier.ColliderDesc.cuboid(hx, hy, hz)
        .setDensity(density)
        .setFriction(0.4)
        .setRestitution(0.05),
      this.chassis,
    );
    this.controller = world.createVehicleController(this.chassis);
    // Our cars face +z with y up (Rapier's default forward axis is x). Rapier 0.21 exposes the
    // forward-axis setter under the property name `setIndexForwardAxis`.
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const r = spec.wheelRadius;
    // Wheel hard points relative to the chassis centre: front pair first (they steer).
    // Wheel bottom = chassis y + attach − spring length − r = ground; solve for the designed
    // ride height with the spring compressed by its static sag.
    const attachY = r + this.restLength - spec.centreY - 0.02;
    const points: [number, number][] = [
      [spec.track / 2, spec.wheelbase / 2],
      [-spec.track / 2, spec.wheelbase / 2],
      [spec.track / 2, -spec.wheelbase / 2],
      [-spec.track / 2, -spec.wheelbase / 2],
    ];
    points.forEach(([wx, wz], i) => {
      this.controller.addWheel(
        { x: wx, y: attachY, z: wz },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        SUSPENSION_REST,
        r,
      );
      this.controller.setWheelSuspensionStiffness(i, stiffness);
      this.controller.setWheelSuspensionCompression(i, 2.4);
      this.controller.setWheelSuspensionRelaxation(i, 3.2);
      this.controller.setWheelMaxSuspensionTravel(i, 0.25);
      // Rapier's default (6 kN) can barely hold 1.4 t under our 16 m/s² gravity: the car sags.
      this.controller.setWheelMaxSuspensionForce(i, 40_000);
      this.controller.setWheelFrictionSlip(i, (i < 2 ? 2.6 : 2.3) * h.grip);
      this.controller.setWheelSideFrictionStiffness(i, 1.1);
    });
    const t0 = this.chassis.translation();
    const r0 = this.chassis.rotation();
    this.prevPos.set(t0.x, t0.y, t0.z);
    this.prevQuat.set(r0.x, r0.y, r0.z, r0.w);
    this.sync();
  }

  step(input: DriveInput): void {
    if (this.disposed) return;
    // Where the chassis is before this physics step, for drawing between steps (sync).
    const t = this.chassis.translation();
    const r = this.chassis.rotation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.set(r.x, r.y, r.z, r.w);
    const spec = this.spec;
    const forwardSpeed = this.controller.currentVehicleSpeed();
    this.speed = forwardSpeed;
    // Steering gets gentler with speed, and eases towards the target.
    const h = this.handling;
    const maxSteer = THREE.MathUtils.lerp(h.steer, 0.14, Math.min(1, Math.abs(forwardSpeed) / 40));
    this.steering += (input.steer * maxSteer - this.steering) * Math.min(1, PHYSICS_DT * 8);
    // Positive input steers right; a positive wheel angle about +y turns towards +x (left).
    for (const i of [0, 1]) this.controller.setWheelSteering(i, -this.steering);

    // Throttle forward; braking while moving forward, reversing once (nearly) stopped.
    let engine = 0;
    let brake = 0;
    // Off the hill roads (owner: the roads are for driving): rough ground drags the car to a
    // crawl (its `rough.top`), and the wheels can't take it up a slope steeper than `rough.climb`.
    const rough = offRoadInHills(t.x, t.z);
    const top = rough ? h.rough.top : Math.min(spec.topSpeed, HARD_TOP_SPEED);
    // The brakes scale with the car's weight (each stops about as well, times its own
    // brakes); the engine only partly, so a heavy van feels it and a light coupe leaps.
    const heft = h.mass / TUNED_MASS;
    const force = spec.engine * heft ** 0.4 * this.power;
    if (input.throttle > 0.05) {
      engine = forwardSpeed < top ? force * input.throttle : 0;
      if (rough && engine > 0 && this.gradeAhead(t, forwardSpeed >= 0) > h.rough.climb) engine = 0;
    } else if (input.throttle < -0.05) {
      if (forwardSpeed > 1) brake = 45 * heft * h.brakes * -input.throttle;
      else if (forwardSpeed > -12) engine = force * 0.6 * input.throttle;
    }
    if (input.brake) brake = Math.max(brake, 55 * heft * h.brakes);
    this.braking = brake > 0;
    // All-wheel drive splits the force over four wheels.
    const driven = h.drive === 'front' ? [0, 1] : h.drive === 'rear' ? [2, 3] : [0, 1, 2, 3];
    for (let i = 0; i < 4; i += 1)
      this.controller.setWheelEngineForce(i, driven.includes(i) ? (engine * 2) / driven.length : 0);
    for (const i of [2, 3]) this.controller.setWheelBrake(i, input.handbrake ? 80 * heft : brake);
    for (const i of [0, 1]) this.controller.setWheelBrake(i, brake * 0.8);
    // Rolling resistance so a released car coasts to a stop; far more on rough ground.
    if (rough) {
      const drag = (Math.abs(forwardSpeed) > h.rough.top ? 30 : 6) * heft;
      for (let i = 0; i < 4; i += 1)
        this.controller.setWheelBrake(i, Math.max(drag, i < 2 ? brake * 0.8 : brake));
    } else if (Math.abs(input.throttle) < 0.05 && !input.brake) {
      for (let i = 0; i < 4; i += 1) this.controller.setWheelBrake(i, 1.5 * heft);
    }
    this.controller.updateVehicle(PHYSICS_DT);
  }

  /** The ground's grade (rise over run) 3 m ahead of the car, or behind it when reversing. */
  private gradeAhead(t: { x: number; z: number }, forward: boolean): number {
    const s = forward ? 3 : -3;
    const ax = t.x + Math.sin(this.yaw) * s;
    const az = t.z + Math.cos(this.yaw) * s;
    return (terrainHeight(ax, az) - terrainHeight(t.x, t.z)) / 3;
  }

  /**
   * Reads the chassis back after the physics steps. `alpha` (0–1) is how far the frame is
   * between the last two steps: the car is drawn that far from where it was to where it is,
   * so it moves smoothly whatever the frame rate (physics runs at a fixed 60 Hz; without
   * this a fast car visibly jumped on frames that ran two steps or none).
   */
  sync(alpha = 1): void {
    if (this.disposed) return;
    const t = this.chassis.translation();
    const r = this.chassis.rotation();
    this.curQuat.set(r.x, r.y, r.z, r.w);
    this.quaternion.copy(this.prevQuat).slerp(this.curQuat, alpha);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion);
    this.yaw = Math.atan2(fwd.x, fwd.z);
    this.position.set(t.x, t.y, t.z).sub(this.prevPos).multiplyScalar(alpha).add(this.prevPos);
    this.position.y -= this.spec.centreY;
    const v = this.chassis.linvel();
    this.velocity.set(v.x, v.y, v.z);
  }

  /**
   * Puts the car where the server says it is (a correction), at rest: the server turned a
   * report down, and carrying on from where it wasn't would leave the two apart for good.
   */
  teleport(x: number, y: number, z: number, yaw: number): void {
    if (this.disposed) return;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.chassis.setTranslation({ x, y: y + this.spec.centreY + 0.05, z }, true);
    this.chassis.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const t = this.chassis.translation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.copy(q);
    this.sync();
  }

  /** Suspension length per wheel, for posing the wheel meshes. */
  wheelState(i: number): { suspension: number; rotation: number; steering: number } {
    return {
      suspension: this.controller.wheelSuspensionLength(i) ?? this.restLength,
      rotation: this.controller.wheelRotation(i) ?? 0,
      steering: this.controller.wheelSteering(i) ?? 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.physics.world.removeVehicleController(this.controller);
    this.physics.world.removeRigidBody(this.chassis);
  }
}
