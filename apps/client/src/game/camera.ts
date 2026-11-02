/**
 * Third-person follow camera: orbits a pivot above the player's shoulders from mouse or touch
 * look input, pulls in when a wall is between it and the player, and eases after the pivot so
 * movement feels smooth. In a car it sits further back and higher.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Physics } from './physics.ts';
import { settings, updateSettings } from './settings.ts';

const ON_FOOT = { distance: 4.2, height: 1.55, side: 0.35 };
const IN_CAR = { distance: 5.6, height: 1.8, side: 0 };
const AIMING = { distance: 2.3, height: 1.6, side: 0.6 };
/** How quickly the view settles into aiming or back out (per second). */
const RIG_EASE = 7;
/** How close and how far the player may zoom (mouse wheel or pinch), and per unit of `zoomBy`. */
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.2;
/** Written to the device once the zooming stops, not on every step of it (ms). */
const ZOOM_SAVE_MS = 600;
const MIN_PITCH = -0.45;
const MAX_PITCH = 1.1;

export class FollowCamera {
  yaw = 0;
  pitch = 0.18;
  /** Radians per pixel of look input. */
  sensitivity = 0.0032;
  inCar = false;
  /** Over-the-shoulder aim view (closer, offset right). */
  aiming = false;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly physics: Physics;
  private readonly pivot = new THREE.Vector3();
  private distance = ON_FOOT.distance;
  /** How far back and to the side the view wants to be, easing between the rigs. */
  private reach = ON_FOOT.distance;
  private side = ON_FOOT.side;
  private readonly tmp = new THREE.Vector3();
  /** Seconds since the player last turned the camera themselves. */
  private idleLook = 0;
  private zoom = settings().zoom;
  private zoomSave = 0;

  constructor(camera: THREE.PerspectiveCamera, physics: Physics) {
    this.camera = camera;
    this.physics = physics;
  }

  /** Moves the view in (below 0) or out, by a share of the distance. */
  zoomBy(amount: number): void {
    if (!amount) return;
    this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + amount), MIN_ZOOM, MAX_ZOOM);
    window.clearTimeout(this.zoomSave);
    this.zoomSave = window.setTimeout(() => updateSettings({ zoom: this.zoom }), ZOOM_SAVE_MS);
  }

  /** Points the camera along `yaw` (e.g. the way a car faces after getting in). */
  face(yaw: number): void {
    this.yaw = yaw;
  }

  /**
   * `behindYaw`: in a car, the heading to drift back behind once the player stops looking
   * around themselves.
   */
  update(
    dt: number,
    look: { x: number; y: number },
    target: THREE.Vector3,
    exclude?: RAPIER.RigidBody,
    behindYaw?: number,
  ): void {
    // The player's look speed and up-down direction (settings).
    const { lookSpeed, invertY } = settings();
    const speed = this.sensitivity * lookSpeed;
    this.yaw -= look.x * speed;
    this.idleLook = look.x !== 0 || look.y !== 0 ? 0 : this.idleLook + dt;
    if (behindYaw !== undefined && this.idleLook > 1.2) {
      let d = behindYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 2.5);
      this.pitch += (0.22 - this.pitch) * Math.min(1, dt * 2);
    }
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + look.y * speed * (invertY ? -1 : 1),
      MIN_PITCH,
      MAX_PITCH,
    );
    const rig = this.inCar ? IN_CAR : this.aiming ? AIMING : ON_FOOT;

    const goal = this.tmp.set(target.x, target.y + rig.height, target.z);
    this.pivot.lerp(goal, 1 - Math.exp(-dt * (this.inCar ? 10 : 18)));
    if (this.pivot.distanceToSquared(goal) > 100) this.pivot.copy(goal);

    // Direction from the pivot back to the camera, with a little over-the-shoulder offset.
    const cp = Math.cos(this.pitch);
    const back = new THREE.Vector3(
      -Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const ease = 1 - Math.exp(-dt * RIG_EASE);
    // Aiming keeps its own close view: the crosshair is set for it.
    const distance = this.aiming && !this.inCar ? rig.distance : rig.distance * this.zoom;
    this.reach += (distance - this.reach) * ease;
    this.side += (rig.side - this.side) * ease;
    const origin = this.pivot.clone().addScaledVector(right, this.side);
    const free = this.physics.rayDistance(origin, back, this.reach + 0.3, exclude) - 0.3;
    const want = Math.max(0.6, Math.min(this.reach, free));
    // Pull in instantly when blocked, ease back out when clear.
    this.distance =
      want < this.distance ? want : this.distance + (want - this.distance) * Math.min(1, dt * 4);
    this.camera.position.copy(origin).addScaledVector(back, this.distance);
    this.camera.lookAt(origin.x, origin.y - (this.inCar ? 1.0 : 0.15), origin.z);
  }
}
