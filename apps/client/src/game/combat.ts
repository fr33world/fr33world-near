/**
 * Client side of combat (technical-plan §9): firing from the crosshair, shot effects for
 * everyone's shots (tracer and muzzle flash), and the player's own health. The server decides
 * every hit; this only shows them, plus an immediate local tracer so firing feels instant.
 */
import { WEAPON } from '@fr33world/protocol';
import { SHOOT_HEIGHT, WEAPONS } from '@fr33world/shared';
import * as THREE from 'three';
import type { NetClient } from './net.ts';
import type { Physics } from './physics.ts';

const TRACERS = 48;
/** How far off the crosshair (radians) touch aim assist reaches. */
const ASSIST_ANGLE = (5 * Math.PI) / 180;
const TRACER_MS = 90;
/** The shape the crosshair turns red over (m). */
const BODY_HEIGHT = 1.85;
const BODY_RADIUS = 0.4;
const CAM_DIR = new THREE.Vector3();
const CAM_POS = new THREE.Vector3();
const BODY = new THREE.Vector3();
const CLOSEST = new THREE.Vector3();

export class Combat {
  /** Weapon in hand (WEAPON.*), NONE when holstered. */
  weapon: number = WEAPON.NONE;
  hp = 100;
  downed = false;
  /** performance.now() of the last confirmed hit we landed (for the hit marker). */
  lastHitAt = 0;
  lastHitHead = false;
  /** performance.now() when we last took damage (for the damage vignette). */
  lastHurtAt = 0;

  private readonly physics: Physics;
  private readonly net: NetClient;
  private readonly tracers: THREE.LineSegments;
  private readonly tracerBorn = new Float64Array(TRACERS);
  private tracerNext = 0;
  private readonly flash: THREE.PointLight;
  private flashUntil = 0;
  private lastShotAt = 0;
  private shotSeq = 0;
  private readonly gun: THREE.Mesh;
  private readonly rifle: THREE.Mesh;
  /**
   * What we carry, as the server says (protocol `arms`): the weapons we own, rounds in each
   * magazine and in all, and when a reload finishes (performance.now()). Null offline.
   */
  arms: {
    weapons: number[];
    licence: boolean;
    mag: Record<number, number>;
    rounds: Record<number, number>;
    reloadEnd: number;
    /** Medicine and bandages (shared CARE items by id). */
    care: Record<string, number>;
  } | null = null;
  /** On duty, as police or a medic (the server's word), else null. */
  duty: 'police' | 'medical' | null = null;

  constructor(scene: THREE.Scene, physics: Physics, net: NetClient) {
    this.physics = physics;
    this.net = net;
    const positions = new Float32Array(TRACERS * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.tracers = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.9 }),
    );
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    this.flash = new THREE.PointLight(0xffc070, 0, 8, 2);
    scene.add(this.flash);
    this.gun = heavyPistol();
    this.rifle = assaultRifle();
  }

  /** The pistol and rifle meshes, for attaching to the character's right hand. */
  get gunMeshes(): THREE.Mesh[] {
    return [this.gun, this.rifle];
  }

  /** The server's word on what we carry (protocol `arms`). */
  setArms(state: {
    weapons: number[];
    licence: boolean;
    rounds: Record<number, number>;
    inHand: number;
    mag: Record<number, number>;
    reloadMs: number;
    duty?: 'police' | 'medical' | 'gang' | null;
    care?: Record<string, number>;
  }): void {
    this.duty = state.duty === 'police' || state.duty === 'medical' ? state.duty : null;
    this.arms = {
      weapons: state.weapons,
      licence: state.licence,
      mag: { ...state.mag },
      rounds: { ...state.rounds },
      reloadEnd: performance.now() + state.reloadMs,
      care: state.care ?? {},
    };
    this.show(state.inHand);
  }

  /** The weapon after the one in hand, cycling through those owned and back to none. */
  nextWeapon(): number {
    const owned = this.arms ? this.arms.weapons : [WEAPON.HEAVY_PISTOL, WEAPON.ASSAULT_RIFLE];
    const order = [WEAPON.NONE, ...owned];
    return order[(order.indexOf(this.weapon) + 1) % order.length] ?? WEAPON.NONE;
  }

  /** Offline (no server to ask): takes it in hand at once. */
  show(weapon: number): void {
    this.weapon = weapon;
    this.gun.visible = weapon === WEAPON.HEAVY_PISTOL;
    this.rifle.visible = weapon === WEAPON.ASSAULT_RIFLE;
  }

  /** Rounds in the magazine in hand and in all, and whether it's reloading (for the HUD). */
  ammo(): { mag: number; total: number; reloading: boolean } | null {
    if (!this.arms || this.weapon === WEAPON.NONE || this.weapon === WEAPON.FIST) return null;
    return {
      mag: this.arms.mag[this.weapon] ?? 0,
      total: this.arms.rounds[this.weapon] ?? 0,
      reloading: performance.now() < this.arms.reloadEnd,
    };
  }

  /**
   * Fires along the camera's centre ray: the muzzle is at the player's shoulder and aims at
   * whatever the crosshair covers, so shots converge on the crosshair.
   */
  fire(
    camera: THREE.Camera,
    feet: THREE.Vector3,
    exclude: unknown,
    assist: readonly THREE.Vector3[] = [],
  ): boolean {
    const stats = WEAPONS[this.weapon];
    const now = performance.now();
    if (!stats || this.downed || now - this.lastShotAt < stats.intervalMs) return false;
    // As the server will: nothing in the magazine, or mid-reload, and it won't fire.
    const a = this.arms;
    if (a && (now < a.reloadEnd || (a.mag[this.weapon] ?? 0) <= 0)) return false;
    if (a) {
      a.mag[this.weapon] = (a.mag[this.weapon] ?? 0) - 1;
      a.rounds[this.weapon] = Math.max(0, (a.rounds[this.weapon] ?? 0) - 1);
    }
    this.lastShotAt = now;

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const reach = this.physics.rayDistance(camPos, camDir, stats.range + 10, exclude as never);
    let target = camPos.clone().addScaledVector(camDir, reach);
    // Aim assist (touch): a player's chest within a few degrees of the crosshair, nearer than
    // what the crosshair covers, takes the shot instead. The server still decides the hit.
    let best = ASSIST_ANGLE;
    for (const chest of assist) {
      const to = chest.clone().sub(camPos);
      const d = to.length();
      if (d > stats.range || d > reach + 1) continue;
      const angle = to.angleTo(camDir);
      if (angle < best) {
        best = angle;
        target = chest.clone();
      }
    }
    const right = new THREE.Vector3(-camDir.z, 0, camDir.x).normalize();
    const origin = feet
      .clone()
      .add(new THREE.Vector3(0, SHOOT_HEIGHT, 0))
      .addScaledVector(right, 0.25);
    const dir = target.clone().sub(origin).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));

    this.shotSeq = (this.shotSeq + 1) & 0xffff;
    if (this.net.connected) {
      this.net.send({
        type: 'shot',
        seq: this.shotSeq,
        weapon: this.weapon,
        // Near players are drawn about 90 ms in the past (see remote.ts).
        viewTime: Math.max(0, Math.round(this.net.serverNow() - 90)),
        x: origin.x,
        y: origin.y,
        z: origin.z,
        yaw,
        pitch,
      });
    }
    const muzzle = origin.clone().addScaledVector(dir, 0.6);
    this.effect(muzzle, dir, Math.min(reach, stats.range));
    return true;
  }

  /** Out of rounds in the magazine with more to load, and not reloading yet. */
  emptied(): boolean {
    const a = this.arms;
    if (!a || performance.now() < a.reloadEnd) return false;
    return (a.mag[this.weapon] ?? 0) <= 0 && (a.rounds[this.weapon] ?? 0) > 0;
  }

  /**
   * Whether the crosshair is on a person (`feet`) in range with nothing solid in the way. A wall
   * between stops it, so the red can't give away someone hiding behind cover.
   */
  onPerson(camera: THREE.Camera, exclude: unknown, feet: readonly THREE.Vector3[]): boolean {
    const stats = WEAPONS[this.weapon];
    if (!stats) return false;
    camera.getWorldDirection(CAM_DIR);
    camera.getWorldPosition(CAM_POS);
    let nearest = Infinity;
    for (const f of feet) {
      // The closest the crosshair's ray comes to the line of their body.
      BODY.set(f.x, f.y + BODY_HEIGHT / 2, f.z).sub(CAM_POS);
      const along = BODY.dot(CAM_DIR);
      if (along <= 0 || along > stats.range + 8) continue;
      CLOSEST.copy(CAM_POS).addScaledVector(CAM_DIR, along);
      if (Math.hypot(CLOSEST.x - f.x, CLOSEST.z - f.z) > BODY_RADIUS) continue;
      if (Math.abs(CLOSEST.y - (f.y + BODY_HEIGHT / 2)) > BODY_HEIGHT / 2) continue;
      if (along < nearest) nearest = along;
    }
    if (nearest === Infinity) return false;
    return this.physics.rayDistance(CAM_POS, CAM_DIR, nearest, exclude as never) >= nearest - 0.5;
  }

  /**
   * A punch where the player faces (`yaw`), at chest height; the server finds who's in reach
   * (the same hit test as a shot, 1.7 m long). Returns whether it was thrown (not too soon).
   */
  punch(feet: THREE.Vector3, yaw: number): boolean {
    const stats = WEAPONS[WEAPON.FIST];
    const now = performance.now();
    if (!stats || this.downed || now - this.lastShotAt < stats.intervalMs) return false;
    this.lastShotAt = now;
    this.shotSeq = (this.shotSeq + 1) & 0xffff;
    if (this.net.connected) {
      this.net.send({
        type: 'shot',
        seq: this.shotSeq,
        weapon: WEAPON.FIST,
        viewTime: Math.max(0, Math.round(this.net.serverNow() - 90)),
        x: feet.x,
        y: feet.y + SHOOT_HEIGHT,
        z: feet.z,
        yaw,
        pitch: -0.1,
      });
    }
    return true;
  }

  /** Someone else's shot, as the server relays it. */
  remoteShot(m: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    distance: number;
    weapon: number;
  }): void {
    // A punch: no tracer.
    if (m.weapon === WEAPON.FIST) return;
    const cp = Math.cos(m.pitch);
    const dir = new THREE.Vector3(Math.sin(m.yaw) * cp, Math.sin(m.pitch), Math.cos(m.yaw) * cp);
    const range = WEAPONS[m.weapon]?.range ?? 60;
    const origin = new THREE.Vector3(m.x, m.y, m.z).addScaledVector(dir, 0.6);
    this.effect(origin, dir, m.distance >= 0 ? m.distance : range);
  }

  onHit(m: { target: number; shooter: number; zone: number; hp: number }, you: number): void {
    if (m.shooter === you) {
      this.lastHitAt = performance.now();
      this.lastHitHead = m.zone === 1;
    }
    if (m.target === you) this.lastHurtAt = performance.now();
  }

  onHealth(hp: number, downed: boolean): void {
    this.hp = hp;
    this.downed = downed;
  }

  private effect(from: THREE.Vector3, dir: THREE.Vector3, length: number) {
    const i = this.tracerNext;
    this.tracerNext = (i + 1) % TRACERS;
    const attr = this.tracers.geometry.getAttribute('position') as THREE.BufferAttribute;
    // A short streak a few metres down range reads better than a full-length laser line.
    const start = from.clone().addScaledVector(dir, Math.min(2, length * 0.2));
    const end = from.clone().addScaledVector(dir, length);
    attr.setXYZ(i * 2, start.x, start.y, start.z);
    attr.setXYZ(i * 2 + 1, end.x, end.y, end.z);
    attr.needsUpdate = true;
    this.tracerBorn[i] = performance.now();
    this.flash.position.copy(from);
    this.flash.intensity = 30;
    this.flashUntil = performance.now() + 50;
  }

  update(): void {
    const now = performance.now();
    const attr = this.tracers.geometry.getAttribute('position') as THREE.BufferAttribute;
    let changed = false;
    for (let i = 0; i < TRACERS; i += 1) {
      const born = this.tracerBorn[i] as number;
      if (born > 0 && now - born > TRACER_MS) {
        this.tracerBorn[i] = 0;
        attr.setXYZ(i * 2, 0, -1000, 0);
        attr.setXYZ(i * 2 + 1, 0, -1000, 0);
        changed = true;
      }
    }
    if (changed) attr.needsUpdate = true;
    if (now > this.flashUntil) this.flash.intensity = 0;
  }
}

let pistolParts: { geometry: THREE.BufferGeometry; material: THREE.Material } | null = null;
let rifleParts: { geometry: THREE.BufferGeometry; material: THREE.Material } | null = null;

/**
 * An unbranded assault rifle, about 88 cm: receiver, barrel, a wooden stock and grip, a curved
 * magazine. Shared like the pistol.
 */
export function assaultRifle(): THREE.Mesh {
  rifleParts ??= buildRifle();
  const gun = new THREE.Mesh(rifleParts.geometry, rifleParts.material);
  gun.castShadow = true;
  gun.visible = false;
  return gun;
}

function buildRifle() {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.6,
  });
  const steel = new THREE.Color(0x26282b);
  const wood = new THREE.Color(0x6b3f22);
  const parts: [THREE.BufferGeometry, THREE.Color][] = [
    [new THREE.BoxGeometry(0.05, 0.07, 0.36).translate(0, 0.03, 0.12), steel],
    [
      new THREE.CylinderGeometry(0.012, 0.012, 0.36, 8)
        .rotateX(Math.PI / 2)
        .translate(0, 0.045, 0.48),
      steel,
    ],
    [new THREE.BoxGeometry(0.045, 0.05, 0.16).translate(0, 0.03, 0.36), wood],
    [new THREE.BoxGeometry(0.04, 0.08, 0.24).rotateX(-0.12).translate(0, 0.01, -0.17), wood],
    [new THREE.BoxGeometry(0.03, 0.1, 0.045).rotateX(0.3).translate(0, -0.06, 0.0), wood],
    [new THREE.BoxGeometry(0.03, 0.15, 0.05).rotateX(-0.35).translate(0, -0.08, 0.14), steel],
  ];
  const positions: number[] = [];
  const colours: number[] = [];
  for (const [g, c] of parts) {
    const flat = g.toNonIndexed();
    const p = flat.getAttribute('position');
    for (let i = 0; i < p.count; i += 1) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      colours.push(c.r, c.g, c.b);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  merged.computeVertexNormals();
  return { geometry: merged, material };
}

/**
 * A blocky heavy pistol (slide, frame, grip), unbranded, about 27 cm long. Every copy shares
 * one geometry and material (other players' guns too).
 */
export function heavyPistol(): THREE.Mesh {
  pistolParts ??= buildPistol();
  const gun = new THREE.Mesh(pistolParts.geometry, pistolParts.material);
  gun.castShadow = true;
  gun.visible = false;
  return gun;
}

function buildPistol() {
  const material = new THREE.MeshStandardMaterial({
    color: 0x2b2d30,
    roughness: 0.35,
    metalness: 0.9,
  });
  const parts = [
    new THREE.BoxGeometry(0.035, 0.045, 0.27).translate(0, 0.035, 0.08),
    new THREE.BoxGeometry(0.03, 0.03, 0.2).translate(0, 0.0, 0.06),
    new THREE.BoxGeometry(0.03, 0.11, 0.05).rotateX(0.25).translate(0, -0.05, -0.02),
  ];
  const merged = new THREE.BufferGeometry();
  const geos = parts.map((g) => g.toNonIndexed());
  const positions = geos.flatMap((g) => Array.from(g.getAttribute('position').array));
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  return { geometry: merged, material };
}
