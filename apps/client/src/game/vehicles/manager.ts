/**
 * Every car in view: its model, a kinematic collider (so people and the driven car bump into
 * it), and its pose, either interpolated from the server or simulated locally while the player
 * drives it. Offline, the parked cars from the layout stand in for the server's.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { VehicleSpawn } from '@fr33world/city';
import { FLAG, NO_ENTITY } from '@fr33world/protocol';
import * as THREE from 'three';
import type { Physics } from '../physics.ts';
import type { RemoteBody } from '../remote.ts';
import { CIVILIAN_CARS, DAMAGE } from '@fr33world/shared';
import { buildCar, CarBatch, type CarModel } from './car-model.ts';
import { DrivenCar } from './driving.ts';
import { Smoke } from './smoke.ts';

/** Cars farther than this from the camera aren't drawn (the haze has them by then). */
const DRAW_DISTANCE = 250;
/** Farthest a car can be above or below someone and still be got into (m). */
const ENTER_HEIGHT = 2.5;

export interface Car {
  id: number;
  model: CarModel;
  driver: number;
  /** Server-interpolated body (online), or null for an offline parked car. */
  remote: RemoteBody | null;
  readonly pos: THREE.Vector3;
  yaw: number;
  speed: number;
  lights: boolean;
  collider: RAPIER.RigidBody;
  wheelSpin: number;
  /** Per wheel this frame: steering angle and spin (radians), suspension drop (m). */
  wheels: { steer: number; spin: number; drop: number }[];
}

export class VehicleManager {
  readonly cars = new Map<number, Car>();
  driven: DrivenCar | null = null;
  drivenId = NO_ENTITY;

  private readonly scene: THREE.Scene;
  private readonly physics: Physics;
  /** Every car of a model drawn together (car-model.ts), by model. */
  private readonly batches = new Map<number, CarBatch>();
  /** Condition (0–1) of the cars the server tells us about: the one we drive, our own. */
  readonly condition = new Map<number, number>();
  private readonly smoke: Smoke;

  constructor(scene: THREE.Scene, physics: Physics) {
    this.scene = scene;
    this.physics = physics;
    this.smoke = new Smoke(scene);
    // The everyday models from the start, so they load (and their shaders compile) with the
    // city rather than when the first car comes into view.
    for (let m = 0; m < CIVILIAN_CARS; m += 1) this.batch(m);
  }

  private batch(model: number): CarBatch {
    let b = this.batches.get(model);
    if (!b) {
      b = new CarBatch(this.scene, model);
      this.batches.set(model, b);
    }
    return b;
  }

  /** Resolves when the everyday models are loaded (the loading screen waits for it). */
  ready(): Promise<void> {
    return Promise.all([...this.batches.values()].map((b) => b.ready.catch(() => {}))).then(
      () => {},
    );
  }

  /** Offline: the layout's parked cars, numbered like the server numbers them. */
  spawnOffline(spawns: VehicleSpawn[]): void {
    spawns.forEach((s, i) => {
      const car = this.add(i + 1, s.model, null);
      car.pos.set(s.x, 0, s.z);
      car.yaw = s.yaw;
    });
  }

  /** Online: a vehicle entity entered view or its seat changed. */
  upsertRemote(body: RemoteBody): void {
    const existing = this.cars.get(body.id);
    if (existing) {
      existing.remote = body;
      existing.driver = body.driver;
      return;
    }
    const car = this.add(body.id, body.model, body);
    car.driver = body.driver;
  }

  remove(id: number): void {
    // The car we drive leaves our server view (we simulate it): keep showing it.
    if (id === this.drivenId) return;
    const car = this.cars.get(id);
    if (!car) return;
    this.physics.world.removeRigidBody(car.collider);
    this.cars.delete(id);
  }

  clear(): void {
    for (const id of [...this.cars.keys()]) this.remove(id);
  }

  private add(id: number, model: number, remote: RemoteBody | null): Car {
    const m = buildCar(model);
    this.batch(m.model);
    const [hx, hy, hz] = m.spec.half;
    const { rapier, world } = this.physics;
    const collider = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased());
    world.createCollider(
      rapier.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, m.spec.centreY, 0),
      collider,
    );
    const car: Car = {
      id,
      model: m,
      driver: NO_ENTITY,
      remote,
      pos: new THREE.Vector3(),
      yaw: 0,
      speed: 0,
      lights: false,
      collider,
      wheelSpin: 0,
      wheels: [0, 1, 2, 3].map(() => ({ steer: 0, spin: 0, drop: 0 })),
    };
    this.cars.set(id, car);
    return car;
  }

  /** The nearest car with a free driver's seat within `radius` of `at`. */
  nearestFree(
    at: THREE.Vector3,
    radius: number,
    allowed: (c: Car) => boolean = () => true,
  ): Car | null {
    let best: Car | null = null;
    let bestD = radius;
    for (const car of this.cars.values()) {
      if (car.driver !== NO_ENTITY || car.id === this.drivenId || !allowed(car)) continue;
      // Not a car on the deck overhead (or the street below).
      if (Math.abs(car.pos.y - at.y) > ENTER_HEIGHT) continue;
      const d = Math.hypot(car.pos.x - at.x, car.pos.z - at.z);
      if (d < bestD) {
        best = car;
        bestD = d;
      }
    }
    return best;
  }

  /** The nearest car someone else is driving, to ride along in. */
  nearestDriven(at: THREE.Vector3, radius: number, you: number): Car | null {
    let best: Car | null = null;
    let bestD = radius;
    for (const car of this.cars.values()) {
      if (car.driver === NO_ENTITY || car.driver === you) continue;
      if (Math.abs(car.pos.y - at.y) > ENTER_HEIGHT) continue;
      const d = Math.hypot(car.pos.x - at.x, car.pos.z - at.z);
      if (d < bestD) {
        best = car;
        bestD = d;
      }
    }
    return best;
  }

  /** Takes the wheel: the car becomes a locally simulated dynamic body. */
  startDriving(id: number): DrivenCar | null {
    const car = this.cars.get(id);
    if (!car) return null;
    car.collider.setEnabled(false);
    this.drivenId = id;
    this.driven = new DrivenCar(
      this.physics,
      car.model.spec,
      car.pos.x,
      car.pos.y,
      car.pos.z,
      car.yaw,
    );
    return this.driven;
  }

  /** Lets go of the wheel; the car stays where it stopped. */
  stopDriving(): Car | null {
    const car = this.cars.get(this.drivenId);
    if (this.driven) {
      if (car) {
        car.pos.copy(this.driven.position);
        car.yaw = this.driven.yaw;
        car.speed = 0;
      }
      this.driven.dispose();
    }
    this.driven = null;
    this.drivenId = NO_ENTITY;
    if (car) {
      car.collider.setEnabled(true);
      car.driver = NO_ENTITY;
    }
    return car ?? null;
  }

  /** Poses every car and every wheel for this frame. */
  update(dt: number, night: number, camera?: THREE.Camera): void {
    this.camera = camera ?? null;
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const car of this.cars.values()) {
      const m = car.model;
      if (car.id === this.drivenId && this.driven) {
        const d = this.driven;
        car.pos.copy(d.position);
        car.yaw = d.yaw;
        car.speed = d.speed;
        m.root.position.copy(d.position);
        m.root.quaternion.copy(d.quaternion);
        for (let i = 0; i < 4; i += 1) {
          const w = d.wheelState(i);
          const slot = car.wheels[i];
          if (!slot) continue;
          slot.steer = i < 2 ? -w.steering : 0;
          slot.spin = w.rotation;
          slot.drop = w.suspension - d.restLength;
        }
        m.setLights(night, d.braking ? 1 : 0);
        continue;
      }
      if (car.remote) {
        car.pos.copy(car.remote.pos);
        car.yaw = car.remote.yaw;
        car.speed = car.remote.speed;
        car.lights = (car.remote.state & FLAG.LIGHTS) !== 0;
      }
      m.root.position.copy(car.pos);
      q.setFromAxisAngle(up, car.yaw);
      m.root.quaternion.copy(q);
      car.wheelSpin += (car.speed * dt) / m.spec.wheelRadius;
      for (const slot of car.wheels) {
        slot.spin = car.wheelSpin;
        slot.steer = 0;
        slot.drop = 0;
      }
      this.smokeFrom(car, dt);
      const driven = car.driver !== NO_ENTITY;
      m.setLights(driven && (car.lights || night > 0.5) ? night : 0, 0);
      car.collider.setNextKinematicTranslation({ x: car.pos.x, y: car.pos.y, z: car.pos.z });
      car.collider.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
    // The car we drive is posed above (it skips the loop's end): its smoke too.
    const mine = this.cars.get(this.drivenId);
    if (mine && this.driven) this.smokeFrom(mine, dt);
    this.smoke.update(dt);
    this.poseWheels();
  }

  /** Smoke from the engine bay of a damaged or wrecked car (the server's flags, or our own). */
  private smokeFrom(car: Car, dt: number) {
    const flags = car.remote?.state ?? 0;
    const health = this.condition.get(car.id);
    const wrecked = (flags & FLAG.WRECKED) !== 0 || health === 0;
    const damaged = wrecked || (flags & FLAG.DAMAGED) !== 0 || (health ?? 1) < DAMAGE.smokeBelow;
    if (!damaged || !this.camera) return;
    const spec = car.model.spec;
    const ahead = spec.length / 2 - 0.8;
    this.bay.set(
      car.pos.x + Math.sin(car.yaw) * ahead,
      car.pos.y + spec.half[1] * 1.6 + 0.2,
      car.pos.z + Math.cos(car.yaw) * ahead,
    );
    this.smoke.emit(car.id, this.bay, wrecked, dt, this.camera.position);
  }
  private readonly bay = new THREE.Vector3();

  /**
   * Hands every car in view to its model's batch: the body's matrix, lamps, and four wheels.
   * Cars off screen or beyond DRAW_DISTANCE aren't drawn (instancing alone would draw every
   * car of a model, wherever it is in the city).
   */
  private poseWheels() {
    const cam = this.camera;
    if (cam) {
      cam.updateMatrixWorld();
      this.viewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.viewProjection);
    }
    const local = this.local;
    const rot = this.rot;
    const euler = this.euler;
    const pos = this.pos;
    for (const b of this.batches.values()) b.begin();
    for (const car of this.cars.values()) {
      const m = car.model;
      if (cam) {
        this.sphere.center.copy(car.pos);
        this.sphere.center.y += 0.8;
        this.sphere.radius = m.spec.length / 2 + 0.5;
        const far = car.pos.distanceToSquared(cam.position) > DRAW_DISTANCE * DRAW_DISTANCE;
        if (car.id !== this.drivenId && (far || !this.frustum.intersectsSphere(this.sphere)))
          continue;
      }
      m.root.updateMatrix();
      m.wheelCentres.forEach((centre, i) => {
        const w = car.wheels[i];
        const out = this.wheelMatrices[i] as THREE.Matrix4;
        if (!w) return;
        pos.set(centre.x, centre.y - w.drop, centre.z);
        // Wheels turn about their axle (x) and steer about y.
        rot.setFromEuler(euler.set(w.spin, w.steer, 0));
        local.compose(pos, rot, this.one);
        out.multiplyMatrices(m.root.matrix, local);
      });
      this.batches.get(m.model)?.add(m.root.matrix, m.head, m.brake, this.wheelMatrices);
    }
    for (const b of this.batches.values()) b.end();
  }

  private camera: THREE.Camera | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly local = new THREE.Matrix4();
  private readonly rot = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly wheelMatrices = [0, 1, 2, 3].map(() => new THREE.Matrix4());
}
