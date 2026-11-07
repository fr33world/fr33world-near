/**
 * Everyone else: snapshot buffers, interpolation, and crowd detail tiers (technical-plan §6).
 *
 * Each remote body is drawn a little in the past (its own interpolation delay, longer for the
 * far tiers that update less often) between the two snapshots around that time, with a short,
 * capped extrapolation if packets are late. Detail by distance rank:
 *   full    nearest 24 within 45 m: skinned character (LOD0 close, LOD1 further), shadows
 *   lite    next 40 within 90 m: skinned LOD2, no shadows, animated every other frame
 *   proxy   the rest: baked-animation instanced characters (crowd.ts), a few draw calls for
 *           the whole crowd; a plain low-poly figure stands in while a look is being baked
 */
import {
  ENTITY_KIND,
  type EntityUpdate,
  FLAG,
  MODE,
  modeOf,
  NO_ENTITY,
  WEAPON,
  EMOTES,
} from '@fr33world/protocol';
import {
  decodeAppearance,
  decodeGear,
  type FactionId,
  readFactionTag,
  uniformOf,
  uniformOutfit,
  type Gear,
  FALL,
} from '@fr33world/shared';
import { BED_TURN, interiorAt } from '@fr33world/city';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PRIORITY } from './assets.ts';
import { moveAngle } from './character/animator.ts';
import { hermite, type Point, Smoother } from './motion.ts';
import { type SeatCar, seatCharacter } from './vehicles/seating.ts';
import { Character, FOOT_LIFT, type Look } from './character/character.ts';
import { assaultRifle, heavyPistol } from './combat.ts';
import { Crowd, type CrowdMember, type Gait } from './crowd.ts';

/** Dev (?crowd): everyone far, to look at the baked crowd up close. */
const ALL_CROWD = import.meta.env.DEV && new URLSearchParams(location.search).has('crowd');
const FULL_MAX = ALL_CROWD ? 0 : 24;
const FULL_RADIUS = 45;
const LITE_MAX = ALL_CROWD ? 0 : 64;
const LITE_RADIUS = 90;
const PROXY_MAX = 512;
const RETIER_MS = 300;
const MAX_EXTRAPOLATE_MS = 250;

type Tier = 'full' | 'lite' | 'proxy';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  state: number;
}

export interface RemoteBody {
  id: number;
  kind: number;
  name: string;
  model: number;
  variant: number;
  /** Interpolated pose this frame. */
  readonly pos: THREE.Vector3;
  yaw: number;
  speed: number;
  vx: number;
  vz: number;
  state: number;
  /** For vehicles: the driver's entity id, or NO_ENTITY. */
  driver: number;
  samples: Sample[];
  /** Average gap between snapshots (ms), for this body's interpolation delay. */
  interval: number;
  tier: Tier;
  character: Character | null;
  loadingLevel: number;
  look: Look;
  /** Police or EMS on duty (in uniform). */
  onDuty: boolean;
  /** The look as sent (encodeAppearance), naming its baked crowd figure. */
  lookCode: number;
  /** Their place in the crowd's walk or idle cycle (s), while drawn far away. */
  crowdPhase: number;
  gear: Gear;
  /** Their faction (name tag colour), or null. */
  faction: FactionId | null;
  /** Their level, beside their name. */
  level: number;
  /** The mode last seen, to catch the moment they jump. */
  lastMode: number;
  distance: number;
  frame: number;
  /** The knock-out clip is holding this character down. */
  downedShown: boolean;
  sittingShown: boolean;
  /** Drawn at the wheel (a seat move started), and the car they got out of, while they do. */
  seatShown: boolean;
  leftCar: SeatCar | null;
  /** Seen on foot since they came into view (so a seat now is them getting in). */
  footSeen: boolean;
  /** The pistol and rifle in this character's hand, made the first time they're seen with one. */
  gun: THREE.Object3D | null;
  rifle: THREE.Object3D | null;
  /** Cars: hides the jump when a late snapshot corrects where it was guessed to be. */
  smoother: Smoother | null;
}

/** What a faction member wears: a real uniform at their rank, or their faction's colours. */
function clothesOf(body: 'male' | 'female', tag: ReturnType<typeof readFactionTag>) {
  const dress = uniformOutfit(tag.faction, tag.rank, tag.onDuty, body);
  return { dress, uniform: dress ? null : uniformOf(tag.faction, tag.onDuty) };
}

export class RemoteWorld {
  readonly bodies = new Map<number, RemoteBody>();
  /** Called when a vehicle body appears or a seat changes (vehicles are drawn elsewhere). */
  onVehicle: (b: RemoteBody) => void = () => {};
  onVehicleGone: (id: number) => void = () => {};
  /** The car a player drives (vehicles are the vehicle manager's), to draw them at its wheel. */
  carOf: (driver: number) => SeatCar | null = () => null;

  private readonly scene: THREE.Scene;
  private readonly proxies: THREE.InstancedMesh;
  private readonly crowd: Crowd;
  private lastRetier = 0;
  private frameNo = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.proxies = new THREE.InstancedMesh(
      proxyFigure(),
      new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true }),
      PROXY_MAX,
    );
    this.proxies.count = 0;
    this.proxies.frustumCulled = false;
    scene.add(this.proxies);
    this.crowd = new Crowd(scene);
  }

  enter(m: {
    id: number;
    kind: number;
    model: number;
    variant: number;
    name: string;
    look: number;
    gear: number;
    faction?: number;
    level?: number;
  }): void {
    const existing = this.bodies.get(m.id);
    if (existing) this.remove(m.id);
    const tag = readFactionTag(m.faction ?? 0);
    const body: RemoteBody = {
      ...m,
      pos: new THREE.Vector3(),
      yaw: 0,
      speed: 0,
      vx: 0,
      vz: 0,
      state: 0,
      driver: NO_ENTITY,
      samples: [],
      interval: 100,
      tier: 'proxy',
      character: null,
      loadingLevel: -1,
      look: {
        ...decodeAppearance(m.look),
        ...clothesOf(decodeAppearance(m.look).body, tag),
      },
      lookCode: m.look,
      onDuty: tag.onDuty,
      // Out of step with everyone else.
      crowdPhase: (m.id * 0.37) % 1,
      gear: decodeGear(m.gear),
      faction: tag.faction,
      level: m.level ?? 0,
      lastMode: MODE.IDLE,
      distance: Infinity,
      frame: 0,
      downedShown: false,
      sittingShown: false,
      smoother: m.kind === ENTITY_KIND.VEHICLE ? new Smoother() : null,
      seatShown: false,
      leftCar: null,
      footSeen: false,
      gun: null,
      rifle: null,
    };
    this.bodies.set(m.id, body);
    if (m.kind === ENTITY_KIND.VEHICLE) this.onVehicle(body);
  }

  leave(id: number): void {
    this.remove(id);
  }

  /** Who rides where: player id to their car and seat. */
  readonly passengers = new Map<number, { vehicle: number; seat: number }>();
  /** A car by id, as a passenger sits in it (set by the Game). */
  carById: (id: number) => SeatCar | null = () => null;

  passenger(player: number, vehicle: number, seat: number): void {
    if (seat === 0) this.passengers.delete(player);
    else this.passengers.set(player, { vehicle, seat });
  }

  seat(vehicle: number, driver: number): void {
    const v = this.bodies.get(vehicle);
    if (!v) return;
    v.driver = driver;
    this.onVehicle(v);
  }

  snapshot(serverTime: number, entities: EntityUpdate[]): void {
    for (const e of entities) {
      const b = this.bodies.get(e.id);
      if (!b) continue;
      const last = b.samples[b.samples.length - 1];
      if (last && serverTime <= last.t) continue;
      if (last) b.interval = b.interval * 0.8 + Math.min(1000, serverTime - last.t) * 0.2;
      b.samples.push({
        t: serverTime,
        x: e.x,
        y: e.y,
        z: e.z,
        yaw: e.yaw,
        vx: e.vx,
        vz: e.vz,
        state: e.state,
      });
      if (b.samples.length > 12) b.samples.shift();
    }
  }

  /** Interpolates every body to its render time, then updates detail tiers and draws. */
  update(dt: number, serverNow: number, camera: THREE.Vector3): void {
    this.frameNo += 1;
    for (const b of this.bodies.values()) {
      this.interpolate(b, serverNow, dt);
      b.distance = b.pos.distanceTo(camera);
    }
    const now = performance.now();
    if (now - this.lastRetier > RETIER_MS) {
      this.lastRetier = now;
      this.retier();
    }
    let proxies = 0;
    this.crowd.begin();
    for (const b of this.bodies.values()) {
      if (b.kind !== ENTITY_KIND.PLAYER || b.samples.length === 0) continue;
      const c = b.character;
      const showCharacter = c !== null && b.tier !== 'proxy';
      if (c) {
        c.root.visible = showCharacter;
        if (showCharacter && this.atWheel(b, c, dt)) continue;
        if (showCharacter) {
          b.footSeen = true;
          c.root.position.copy(b.pos);
          c.root.position.y += FOOT_LIFT;
          const downed = modeOf(b.state) === MODE.DOWNED;
          const inBed = downed && interiorAt(b.pos.x, b.pos.z)?.id === 'hospital';
          c.root.rotation.set(0, b.yaw + (inBed ? BED_TURN : 0), 0);
          if (downed !== b.downedShown) {
            b.downedShown = downed;
            const indoors = interiorAt(b.pos.x, b.pos.z);
            if (downed) void c.animator?.[indoors ? 'lie' : 'hold']('knocked_out');
            else if (indoors) c.animator?.stop();
            else c.animator?.getUp(FALL.getUpMs / 1000);
          }
          const sitting = modeOf(b.state) === MODE.SITTING;
          if (sitting !== b.sittingShown) {
            b.sittingShown = sitting;
            void c.animator?.[sitting ? 'sit' : 'stand']();
          }
          const armed = (b.state & FLAG.ARMED) !== 0 && !downed;
          this.arm(b, c, armed);
          // Just left the ground going up: their jump.
          const now = modeOf(b.state);
          if (now === MODE.JUMP && b.lastMode !== MODE.JUMP && b.lastMode !== MODE.FALL)
            c.animator?.jump();
          b.lastMode = now;
          // The lite tier animates every other frame, at double step.
          const lite = b.tier === 'lite';
          if (!lite || (this.frameNo + b.id) % 2 === 0) {
            const mode = modeOf(b.state);
            const moving = mode === MODE.WALK || mode === MODE.RUN;
            const angle = armed ? moveAngle(b.vx, b.vz, b.yaw) : undefined;
            c.update(
              lite ? dt * 2 : dt,
              moving ? b.speed : 0,
              mode === MODE.WALK ? 'walk' : 'run',
              angle,
            );
          }
        }
      }
      if (!showCharacter && modeOf(b.state) === MODE.SEATED) continue;
      if (!showCharacter) {
        const member = crowdMember(b);
        const drawn = this.crowd.add(member, dt);
        b.crowdPhase = member.phase;
        if (drawn) continue;
      }
      if (!showCharacter && proxies < PROXY_MAX) {
        this.q.setFromAxisAngle(this.up, b.yaw);
        this.m.compose(b.pos, this.q, this.one);
        this.proxies.setMatrixAt(proxies, this.m);
        this.proxies.setColorAt(proxies, proxyColour(b.id));
        proxies += 1;
      }
    }
    this.crowd.end();
    this.proxies.count = proxies;
    this.proxies.instanceMatrix.needsUpdate = true;
    if (this.proxies.instanceColor) this.proxies.instanceColor.needsUpdate = true;
  }

  private interpolate(b: RemoteBody, serverNow: number, dt: number) {
    const s = b.samples;
    const first = s[0];
    if (!first) return;
    const delay = Math.min(450, Math.max(90, b.interval * 2.2));
    const t = serverNow - delay;
    let i = s.length - 1;
    while (i > 0 && (s[i] as Sample).t > t) i -= 1;
    const a = s[i] as Sample;
    const next = s[i + 1];
    if (next && t >= a.t) {
      const k = (t - a.t) / Math.max(1, next.t - a.t);
      b.pos.set(a.x + (next.x - a.x) * k, a.y + (next.y - a.y) * k, a.z + (next.z - a.z) * k);
      if (b.smoother) {
        // Cars follow the curve through both snapshots' positions and velocities.
        const c = hermite(a, next, Math.max(1, next.t - a.t) / 1000, k, this.curve);
        b.pos.x = c.x;
        b.pos.z = c.z;
      }
      let dy = next.yaw - a.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      b.yaw = a.yaw + dy * k;
      b.vx = a.vx + (next.vx - a.vx) * k;
      b.vz = a.vz + (next.vz - a.vz) * k;
      b.speed = Math.hypot(b.vx, b.vz);
      b.state = k < 0.5 ? a.state : next.state;
    } else {
      // Late: carry on along the last velocity for a little while, then hold.
      const last = s[s.length - 1] as Sample;
      const ahead = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, t - last.t)) / 1000;
      b.pos.set(last.x + last.vx * ahead, last.y, last.z + last.vz * ahead);
      b.yaw = last.yaw;
      b.vx = last.vx;
      b.vz = last.vz;
      b.speed = Math.hypot(last.vx, last.vz);
      b.state = last.state;
    }
    if (b.smoother) {
      const drawn = b.smoother.apply(b.pos.x, b.pos.z, b.speed, dt, this.drawn);
      b.pos.x = drawn.x;
      b.pos.z = drawn.z;
    }
  }
  private readonly curve: Point = { x: 0, z: 0, vx: 0, vz: 0 };
  private readonly drawn = { x: 0, z: 0 };

  /**
   * A player in a car, or getting out of one: drawn at its wheel (getting in when they've just
   * sat down, out when they've just left). True when it placed them.
   */
  private atWheel(b: RemoteBody, c: Character, dt: number): boolean {
    const a = c.animator;
    const seated = modeOf(b.state) === MODE.SEATED;
    const riding = this.passengers.get(b.id);
    const car = !seated ? null : riding ? this.carById(riding.vehicle) : this.carOf(b.id);
    if (seated && car) {
      if (!b.seatShown) {
        b.seatShown = true;
        b.leftCar = null;
        // Sitting down now (they were on foot in view), or already at the wheel when first seen.
        void (riding ? a?.ride() : b.footSeen ? a?.getIn() : a?.drive());
      }
      b.lastMode = MODE.SEATED;
      b.leftCar = { pos: car.pos.clone(), yaw: car.yaw, id: car.id };
      seatCharacter(
        c.root,
        car,
        a?.seat === 'enter' ? 'enter' : 'drive',
        a?.hipsRestY ?? 0.9,
        riding?.seat ?? 0,
      );
      c.update(dt, 0);
      return true;
    }
    if (b.seatShown) {
      b.seatShown = false;
      if (b.leftCar) void a?.getOut();
      else a?.stop();
    }
    // Climbing out of the car they left, until they walk off.
    if (b.leftCar && a?.seat === 'exit') {
      seatCharacter(c.root, b.leftCar, 'exit', a.hipsRestY);
      // Walking off ends it.
      c.update(dt, b.speed);
      return true;
    }
    b.leftCar = null;
    // In a car out of view: not drawn.
    if (seated) c.root.visible = false;
    return seated;
  }

  /** Ranks players by distance and moves them between full, lite and proxy detail. */
  private retier() {
    const players = [...this.bodies.values()].filter((b) => b.kind === ENTITY_KIND.PLAYER);
    players.sort((a, b) => a.distance - b.distance);
    players.forEach((b, rank) => {
      const tier: Tier =
        rank < FULL_MAX && b.distance < FULL_RADIUS
          ? 'full'
          : rank < LITE_MAX && b.distance < LITE_RADIUS
            ? 'lite'
            : 'proxy';
      b.tier = tier;
      const level = tier === 'full' ? (b.distance < 15 ? 0 : 1) : tier === 'lite' ? 2 : -1;
      if (level >= 0 && level !== b.loadingLevel) this.loadCharacter(b, level);
      if (b.character)
        b.character.root.traverse((o) => (o.castShadow = tier === 'full' && rank < 8));
    });
  }

  /** Stance, aim and the pistol in hand, from the body's reported flags. */
  private arm(b: RemoteBody, c: Character, armed: boolean) {
    const rifle = armed && (b.state & FLAG.RIFLE) !== 0;
    c.animator?.setStance(armed ? (rifle ? 'rifle' : 'pistol') : 'unarmed');
    c.animator?.setAiming(armed && (b.state & FLAG.AIM) !== 0);
    c.animator?.setTalking((b.state & FLAG.TALKING) !== 0);
    if (armed && !rifle && !b.gun) {
      const gun = heavyPistol();
      if (c.holdInRightHand(gun)) b.gun = gun;
    }
    if (rifle && !b.rifle) {
      const gun = assaultRifle();
      if (c.holdInRightHand(gun)) b.rifle = gun;
    }
    if (b.gun) b.gun.visible = armed && !rifle;
    if (b.rifle) b.rifle.visible = rifle;
  }

  /** Someone fired (shot effects from the server): their recoil. */
  fired(id: number, weapon: number, pitch = 0): void {
    const animator = this.bodies.get(id)?.character?.animator;
    // Their spine bends to where they shot (their aim's only up-down sign others get).
    if (animator) animator.pitch = pitch;
    if (weapon === WEAPON.FIST) animator?.punch();
    else animator?.fire();
  }

  /** Someone in view started an emote. */
  emote(id: number, index: number): void {
    const e = EMOTES[index];
    const c = this.bodies.get(id)?.character;
    if (e) c?.emote(e.clip, e.loop);
  }

  /** Someone hit flinches (the server tells everyone near). */
  hit(id: number, hp: number): void {
    if (hp > 0) this.bodies.get(id)?.character?.animator?.hit();
  }

  private loadCharacter(b: RemoteBody, level: number) {
    b.loadingLevel = level;
    void Character.load(b.look, level, PRIORITY.byDistance(b.distance), b.gear).then((c) => {
      // Dropped or re-tiered while loading: discard.
      if (this.bodies.get(b.id) !== b || b.loadingLevel !== level) return;
      if (b.character) this.scene.remove(b.character.root);
      b.character = c;
      // A new detail level is a new skeleton: the gun goes back in the new hand when needed.
      b.gun = null;
      this.scene.add(c.root);
    });
  }

  private remove(id: number) {
    const b = this.bodies.get(id);
    if (!b) return;
    if (b.character) this.scene.remove(b.character.root);
    this.bodies.delete(id);
    if (b.kind === ENTITY_KIND.VEHICLE) this.onVehicleGone(id);
  }

  clear(): void {
    for (const id of [...this.bodies.keys()]) this.remove(id);
  }
}

/** A far player as the crowd draws them: their look, place, and gait from what they report. */
function crowdMember(b: RemoteBody): CrowdMember {
  const mode = modeOf(b.state);
  const moving = (mode === MODE.WALK || mode === MODE.RUN) && b.speed > 0.45;
  const gait: Gait = !moving ? 'idle' : mode === MODE.WALK ? 'walk' : 'run';
  return {
    look: b.look,
    lookKey: b.lookCode,
    pos: b.pos,
    yaw: b.yaw,
    gait,
    speed: b.speed,
    phase: b.crowdPhase,
  };
}

/**
 * A low-poly person while a look is being baked, about 1.75 m: skin-tone head and hands, a shirt, jeans and
 * dark shoes as vertex colours, so a distant crowd still reads as people.
 */
function proxyFigure(): THREE.BufferGeometry {
  const part = (g: THREE.BufferGeometry, colour: number, x: number, y: number, z = 0) => {
    g.translate(x, y, z);
    const flat = g.toNonIndexed();
    const c = new THREE.Color(colour);
    const n = flat.getAttribute('position').count;
    flat.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(
        new Array(n).fill(0).flatMap(() => [c.r, c.g, c.b]),
        3,
      ),
    );
    return flat;
  };
  const skin = 0x8a5a3c;
  const g = mergeGeometries([
    part(new THREE.SphereGeometry(0.11, 8, 6), skin, 0, 1.64),
    part(new THREE.CapsuleGeometry(0.16, 0.42, 2, 8), 0xe8e6e0, 0, 1.22),
    part(new THREE.CapsuleGeometry(0.05, 0.5, 2, 6), 0xe8e6e0, -0.22, 1.18),
    part(new THREE.CapsuleGeometry(0.05, 0.5, 2, 6), 0xe8e6e0, 0.22, 1.18),
    part(new THREE.CapsuleGeometry(0.075, 0.72, 2, 6), 0x3d5a80, -0.09, 0.5),
    part(new THREE.CapsuleGeometry(0.075, 0.72, 2, 6), 0x3d5a80, 0.09, 0.5),
    part(new THREE.BoxGeometry(0.11, 0.08, 0.24), 0x1c1c1e, -0.09, 0.04, 0.04),
    part(new THREE.BoxGeometry(0.11, 0.08, 0.24), 0x1c1c1e, 0.09, 0.04, 0.04),
  ]);
  g.computeVertexNormals();
  return g;
}

const proxyShades = [0.82, 0.9, 1, 1.08, 0.95].map((v) => new THREE.Color(v, v, v));
function proxyColour(id: number): THREE.Color {
  return proxyShades[id % proxyShades.length] as THREE.Color;
}
