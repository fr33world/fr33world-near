/**
 * Clip-driven character animation on the shared Mixamo-named skeleton, adapted from the
 * earlier FreeWorld client. Clips come from packs built from the owner's Mixamo downloads
 * (scripts/build-animations.mjs), retargeted onto the Rocketbox skeleton (scripts/assets/rocketbox.mjs).
 *
 * Three layers, blended by hand-ramped weights:
 * - locomotion: the clip for the current stance (unarmed or pistol), gait and, while armed,
 *   direction (forward, back, strafe), split into a legs half and an upper-body half;
 * - an upper-body overlay (aim, fire, hit reaction) that replaces the locomotion's upper half,
 *   so a player can shoot or flinch while running;
 * - a full-body one-shot (emotes, the knock-out fall) over everything.
 */
import * as THREE from 'three';
import { loadModel } from '../assets.ts';
import { bakeGesture, CARE_SECONDS, type CareGesture } from './patchup.ts';

export const CORE_PACK = 'animations/rocketbox_core.glb';
export const COMBAT_PACK = 'animations/rocketbox_combat.glb';
export const DANCE_PACK = 'animations/rocketbox_dances.glb';
/** Sitting on chairs and taking medicine (fetched the first time either happens near a player). */
export const REST_PACK = 'animations/rocketbox_rest.glb';
/** The owner's later dances. */
export const MOVES_PACK = 'animations/rocketbox_moves.glb';
export const PISTOL_PACK = 'animations/rocketbox_pistol.glb';
/** The owner's standing idle and the talking gestures (small; fetched with the character). */
export const SOCIAL_PACK = 'animations/rocketbox_social.glb';
/** The rifle's stance (fetched the first time anyone near holds one). */
export const RIFLE_PACK = 'animations/rocketbox_rifle.glb';
/** Sitting at the wheel, getting in and out (fetched with the first car in view). */
export const VEHICLE_PACK = 'animations/rocketbox_vehicle.glb';

export type Stance = 'unarmed' | 'pistol' | 'rifle';
export type Move =
  'idle' | 'walk' | 'run' | 'walk_back' | 'run_back' | 'strafe_left' | 'strafe_right';

/** Clips per stance and move, first available wins. Unarmed characters face where they go. */
const SETS: Record<Stance, Partial<Record<Move, readonly string[]>>> = {
  unarmed: { idle: ['standing_idle', 'idle', 'neutral_idle'], walk: ['walking'], run: ['running'] },
  pistol: {
    idle: ['pistol_idle'],
    walk: ['pistol_walk'],
    run: ['pistol_run'],
    walk_back: ['pistol_walk_backward'],
    run_back: ['pistol_run_backward'],
    strafe_left: ['pistol_strafe_left'],
    strafe_right: ['pistol_strafe_right'],
  },
  rifle: {
    idle: ['rifle_idle'],
    walk: ['rifle_walk'],
    run: ['rifle_run'],
    walk_back: ['rifle_walk_backward'],
    run_back: ['rifle_run_backward'],
    strafe_left: ['rifle_strafe_left'],
    strafe_right: ['rifle_strafe_right'],
  },
};
/** How long the gun stays up after a shot from the hip (s). */
const SHOT_RAISED_S = 0.5;

/** The upper-body pose for aiming each stance. */
const AIM_CLIP: Record<Stance, string> = {
  unarmed: 'pistol_fire',
  pistol: 'pistol_fire',
  rifle: 'rifle_aim',
};

/**
 * Ground speed each clip was authored at (m/s), so playback matches movement. The pistol
 * clips' speeds are the hips' travel reported by the build script.
 */
const CLIP_SPEED: Record<string, number> = {
  walking: 1.35,
  running: 3.6,
  pistol_walk: 2.97,
  pistol_run: 5.52,
  pistol_walk_backward: 1.63,
  pistol_run_backward: 3.83,
  pistol_strafe_left: 2.5,
  pistol_strafe_right: 2.5,
  rifle_walk: 2.14,
  rifle_run: 5.36,
  rifle_walk_backward: 2.15,
  rifle_run_backward: 5.36,
  rifle_strafe_left: 2.14,
  rifle_strafe_right: 2.14,
};

/** Locomotion clips are pinned in place: the game moves the body, not the clip. */
const PINNED = new Set<string>(
  [...Object.values(SETS.unarmed), ...Object.values(SETS.pistol), ...Object.values(SETS.rifle)]
    .flat()
    .filter((n) => n in CLIP_SPEED)
    // The Step dance walks three metres forward and back: it dances on the spot.
    .concat('knocked_out', 'jump', 'step_hip_hop'),
);
/**
 * Clips that end where the body is placed, not start there: sitting down ends on the chair, a
 * half-step behind where it began, and getting up ends in front of it.
 */
const END_AT_BODY = new Set(['stand_to_sit', 'sit_to_stand']);
/**
 * Clips whose own rise the physics already makes (the jump): the hips go no higher than
 * standing, so the body isn't lifted twice; crouches below it stay.
 */
const NO_RISE = new Set(['jump']);
/** Where the jump leaves the ground in its clip (s): it plays from there. */
const JUMP_TAKEOFF = 0.05;

/** Which pack holds a clip outside the core. */
const PACK_OF: Record<string, string> = {
  standing_idle: SOCIAL_PACK,
  talking: SOCIAL_PACK,
  jump: SOCIAL_PACK,
  punching: COMBAT_PACK,
  knocked_out: COMBAT_PACK,
  hip_hop_dancing: DANCE_PACK,
  dancing: DANCE_PACK,
  dancing_twerk: DANCE_PACK,
  snake_hip_hop: MOVES_PACK,
  step_hip_hop: MOVES_PACK,
  sitting_idle: REST_PACK,
  stand_to_sit: REST_PACK,
  sit_to_stand: REST_PACK,
  driving: VEHICLE_PACK,
  entering_car: VEHICLE_PACK,
  exiting_car: VEHICLE_PACK,
};
for (const name of Object.values(SETS.pistol).flat()) PACK_OF[name] = PISTOL_PACK;
for (const name of ['pistol_fire', 'pistol_reload', 'hit_reaction']) PACK_OF[name] = PISTOL_PACK;
for (const name of [...Object.values(SETS.rifle).flat(), 'rifle_aim']) PACK_OF[name] = RIFLE_PACK;
const STANCE_PACK: Record<Stance, string> = {
  unarmed: CORE_PACK,
  pistol: PISTOL_PACK,
  rifle: RIFLE_PACK,
};

/** Seconds to blend locomotion and one-shots; overlays come in faster so shots feel instant. */
const FADE = 0.22;
const OVERLAY_IN = 0.06;
const OVERLAY_OUT = 0.18;
/** The hit reaction is a long stagger; only its start plays. */
const HIT_SECONDS = 0.8;

/**
 * Getting into a car: the clip walks up to the door first (skipped: the player is already
 * there), then turns and sits; quicker than recorded so it doesn't hold the player up. Getting
 * out plays whole, quicker too. Each ends or starts seated, hips where the Driving clip has
 * them (bakeSeat), so the switch to and from driving doesn't jump.
 */
export const SEAT = {
  /**
   * Off for launch (owner, 2026-10-31: not good enough yet): getting in and out happen at once,
   * as before; the driver still sits at the wheel. Back after launch (track.md).
   */
  doors: false,
  enterFrom: 1.6,
  enterSpeed: 1.6,
  exitSpeed: 1.8,
  /**
   * The clips' hips, as fractions of the rig's resting hip height: standing, seated in the
   * Getting in and out clips, and seated in the Driving clip (measured, scripts' pose page).
   * Where the Getting-in clip ends (x, z) and the way it then faces (yaw), against its start.
   */
  stand: 0.983,
  seated: 0.856,
  driving: 0.611,
  enterEnd: { x: -0.0852, z: 1.999, yaw: 1.566 },
} as const;

/** How much quicker than recorded sitting down and getting up play. */
const SIT_SPEED = 1.5;

const BEND_AXIS = new THREE.Vector3();
const BEND_Q = new THREE.Quaternion();
const BEND_PARENT = new THREE.Quaternion();
const BEND_TURN = new THREE.Quaternion();
const BEND_LOCAL = new THREE.Quaternion();

/** Spine, neck, head, shoulders, arms and hands; the hips and legs stay with locomotion. */
const UPPER_BONE = /(Spine|Neck|Head|Shoulder|Arm|Hand)[^.]*\./;

/**
 * Makes a clip safe for our rig whatever units it was exported in: rotations, plus the hips
 * position scaled by `scale` (our rest hip height ÷ the pack's) and made relative to the
 * clip's first frame horizontally. Other position tracks and all scale tracks are dropped.
 */
export function normalizeClip(
  clip: THREE.AnimationClip,
  scale: number,
  hipsRestY = Infinity,
): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  const pinned = PINNED.has(clip.name);
  const top = NO_RISE.has(clip.name) ? hipsRestY : Infinity;
  for (const track of clip.tracks) {
    if (track.name.endsWith('.quaternion')) {
      tracks.push(track);
    } else if (/Hips\.position$/.test(track.name)) {
      const v = track.values;
      const from = END_AT_BODY.has(clip.name) ? v.length - 3 : 0;
      const x0 = v[from] ?? 0;
      const z0 = v[from + 2] ?? 0;
      const out = new Float32Array(v.length);
      const seat = clip.name === 'entering_car' || clip.name === 'exiting_car';
      for (let i = 0; i < v.length; i += 3) {
        out[i] = pinned ? 0 : ((v[i] ?? 0) - x0) * scale;
        out[i + 1] = Math.min(top, (v[i + 1] ?? 0) * scale);
        out[i + 2] = pinned ? 0 : ((v[i + 2] ?? 0) - z0) * scale;
        if (seat) out[i + 1] = bakeSeat(out[i + 1] as number, hipsRestY);
      }
      tracks.push(
        new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(out)),
      );
    }
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Getting in and out sit on a higher seat than Driving: their hips are lowered as they sit, in
 * step with how far down they are, so seated they're where Driving has them and standing they
 * don't move.
 */
function bakeSeat(y: number, rest: number): number {
  if (!Number.isFinite(rest)) return y;
  const stand = SEAT.stand * rest;
  const seated = SEAT.seated * rest;
  const down = Math.max(0, Math.min(1, (stand - y) / (stand - seated)));
  return y - down * (SEAT.seated - SEAT.driving) * rest;
}

/** The upper-body or the legs-and-hips half of a clip. */
export function halfClip(clip: THREE.AnimationClip, upper: boolean): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => UPPER_BONE.test(t.name) === upper);
  return new THREE.AnimationClip(
    `${clip.name}:${upper ? 'upper' : 'lower'}`,
    clip.duration,
    tracks,
  );
}

/**
 * Which way a body moves relative to where it faces, in radians: 0 forward, +π/2 to its left,
 * ±π backwards. Yaw follows the game's convention (facing +z at 0, atan2(x, z)).
 */
export function moveAngle(vx: number, vz: number, yaw: number): number {
  const forward = vx * Math.sin(yaw) + vz * Math.cos(yaw);
  const left = vx * Math.cos(yaw) - vz * Math.sin(yaw);
  return Math.atan2(left, forward);
}

interface Pack {
  path: string;
  clips: THREE.AnimationClip[];
  hipsRestY: number;
}

const packs = new Map<string, Promise<Pack>>();
const normalized = new Map<string, THREE.AnimationClip[]>();

export function loadAnimationPack(path = CORE_PACK): Promise<Pack> {
  let p = packs.get(path);
  if (!p) {
    p = loadModel(path, path === CORE_PACK ? 1 : 60).then(
      (g) => {
        let hipsRestY = 0;
        g.scene.traverse((o) => {
          if (/Hips$/.test(o.name) && !hipsRestY) hipsRestY = o.position.y;
        });
        return { path, clips: g.animations, hipsRestY };
      },
      () => ({ path, clips: [], hipsRestY: 0 }),
    );
    packs.set(path, p);
  }
  return p;
}

function clipsFor(p: Pack, hipsRestY: number): THREE.AnimationClip[] {
  const key = `${p.path}@${hipsRestY.toFixed(3)}`;
  let list = normalized.get(key);
  if (!list) {
    const scale = p.hipsRestY > 0 ? hipsRestY / p.hipsRestY : 1;
    list = p.clips.map((c) => normalizeClip(c, scale, hipsRestY));
    normalized.set(key, list);
  }
  return list;
}

/**
 * The unarmed idle, walk and run as the animator plays them on a rig whose hips rest at
 * `hipsRestY`, with the ground speed each was authored at (m/s; 0 for the idle). For baking
 * far crowds (crowd.ts).
 */
export async function locomotionClips(
  hipsRestY: number,
): Promise<Record<'idle' | 'walk' | 'run', { clip: THREE.AnimationClip; speed: number }> | null> {
  const loaded = await Promise.all([CORE_PACK, SOCIAL_PACK].map((p) => loadAnimationPack(p)));
  const all = loaded.flatMap((p) => clipsFor(p, hipsRestY));
  const find = (names: readonly string[] = []) =>
    names.map((n) => all.find((c) => c.name === n)).find((c) => c !== undefined);
  const idle = find(SETS.unarmed.idle);
  const walk = find(SETS.unarmed.walk);
  const run = find(SETS.unarmed.run);
  if (!idle || !walk || !run) return null;
  return {
    idle: { clip: idle, speed: 0 },
    walk: { clip: walk, speed: CLIP_SPEED[walk.name] ?? 1.35 },
    run: { clip: run, speed: CLIP_SPEED[run.name] ?? 3.6 },
  };
}

/**
 * Which locomotion move fits. The gait comes from what the player is doing (walk or run), not
 * only the measured speed, which dips for a frame on every turn or correction; speed decides
 * standing still, with a margin so it doesn't flicker. `angle` (moveAngle) picks a direction
 * when the stance has directional clips; without it the body faces where it goes.
 */
export function pickMove(
  current: Move | null,
  speed: number,
  gait?: 'walk' | 'run',
  angle?: number,
): Move {
  const moving = current && current !== 'idle' ? speed > 0.2 : speed > 0.45;
  if (!moving) return 'idle';
  let fast: boolean;
  if (gait === 'run') fast = speed > 1.6 || current === 'run' || current === 'run_back';
  else if (gait === 'walk') fast = false;
  else if (current === 'run' || current === 'run_back') fast = speed > 2.6;
  else fast = speed > 3.2;
  if (angle === undefined) return fast ? 'run' : 'walk';
  const a = Math.abs(angle);
  if (a <= (55 * Math.PI) / 180) return fast ? 'run' : 'walk';
  if (a >= (125 * Math.PI) / 180) return fast ? 'run_back' : 'walk_back';
  return angle > 0 ? 'strafe_left' : 'strafe_right';
}

interface Layered {
  lower: THREE.AnimationAction;
  upper: THREE.AnimationAction;
}

/** An action whose weight ramps toward 1 while wanted and toward 0 after. */
interface Ramp {
  action: THREE.AnimationAction;
  weight: number;
  wanted: boolean;
  /** Seconds left before it lets go by itself (hit reaction), or Infinity. */
  timeLeft: number;
}

export class Animator {
  private readonly mixer: THREE.AnimationMixer;
  /** The rig's resting hip height (m). */
  readonly hipsRestY: number;
  private readonly clips = new Map<string, THREE.AnimationClip>();
  private readonly fetched = new Map<string, Promise<void>>();
  private readonly layered = new Map<string, Layered>();
  private readonly overlays = new Map<string, THREE.AnimationAction>();
  private readonly fulls = new Map<string, THREE.AnimationAction>();

  private stance: Stance = 'unarmed';
  private move: Move | null = null;
  /** Locomotion clip name → weight; the current clip ramps up, the rest down and out. */
  private readonly loco = new Map<string, number>();
  private current: string | null = null;
  private overlay: Ramp | null = null;
  private aiming = false;
  private talking = false;
  private oneShot: Ramp | null = null;
  /** A held one-shot (hold()) ignores movement and finishing; only stop() ends it. */
  private held = false;
  /**
   * In a car: getting in, at the wheel, getting out; null on foot. It changes only once the
   * move's clip is playing, so whoever places the character never sees one clip in another's
   * place. `seatAsk` counts requests, so a later one wins over an earlier still loading.
   */
  seat: 'enter' | 'drive' | 'exit' | null = null;
  private seatAsk = 0;
  /** On a chair, or on the way down onto one. */
  private sitting = false;

  /**
   * Aim pitch (radians, up positive): while aiming, the spine bends that way, split over its
   * three bones, so the gun points where the crosshair does (Phase 8).
   */
  pitch = 0;
  private shownPitch = 0;
  private readonly root: THREE.Object3D;
  private spine: THREE.Object3D[] | null = null;
  private shins: THREE.Object3D[] | null = null;
  private shinsFolded = false;
  /** Each spine bone before and after last frame's bend (to take it off again, see update). */
  private readonly unbent: THREE.Quaternion[] = [];
  private readonly bent: THREE.Quaternion[] = [];

  private constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], hipsRestY: number) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.hipsRestY = hipsRestY;
    this.mixer.addEventListener('finished', (e: { action: THREE.AnimationAction }) => {
      // In: straight on to the wheel. Out: back on foot.
      if (this.seat === 'enter' && this.fulls.get('entering_car') === e.action) void this.drive();
      if (this.seat === 'exit' && this.fulls.get('exiting_car') === e.action) this.seat = null;
      // Down onto the chair: settled.
      if (this.sitting && this.fulls.get('stand_to_sit') === e.action) {
        const settled = this.fulls.get('sitting_idle');
        if (!settled) return;
        settled.setLoop(THREE.LoopRepeat, Infinity);
        this.startOneShot(settled, 1);
        this.held = true;
      }
    });
    this.addClips(clips);
    this.mixer.addEventListener('finished', (e: { action: THREE.AnimationAction }) => {
      if (this.oneShot?.action === e.action && !this.held) this.oneShot.wanted = false;
      // A shot finished: stay raised while aiming (the clip clamps on its last frame).
      if (this.overlay?.action === e.action && !this.aiming) this.overlay.wanted = false;
    });
  }

  static create(root: THREE.Object3D, p: Pack, hipsRestY: number): Animator | null {
    if (p.clips.length === 0) return null;
    const a = new Animator(root, clipsFor(p, hipsRestY), hipsRestY);
    // The standing idle takes over from the core's as soon as it's in.
    void a.ensure(SOCIAL_PACK);
    return a;
  }

  private addClips(clips: THREE.AnimationClip[]) {
    for (const clip of clips) if (!this.clips.has(clip.name)) this.clips.set(clip.name, clip);
  }

  /** Fetches the pack holding `name` if needed (once per animator). */
  /** Fetches the car clips ahead of need (the player walked up to a car). */
  preloadCar(): void {
    void this.ensure(VEHICLE_PACK);
  }

  private ensure(path: string): Promise<void> {
    let p = this.fetched.get(path);
    if (!p) {
      p = loadAnimationPack(path).then((pack) => this.addClips(clipsFor(pack, this.hipsRestY)));
      this.fetched.set(path, p);
    }
    return p;
  }

  private async clip(name: string): Promise<THREE.AnimationClip | undefined> {
    const path = PACK_OF[name];
    if (!this.clips.has(name) && path) await this.ensure(path);
    return this.clips.get(name);
  }

  /** Unarmed or holding a pistol. The pistol clips load on first use; until then, unarmed. */
  setStance(stance: Stance): void {
    if (stance === this.stance) return;
    this.stance = stance;
    void this.ensure(STANCE_PACK[stance]);
    if (stance === 'unarmed') this.setAiming(false);
    // From pistol to rifle while aiming: the other aim.
    else if (this.aiming) {
      this.aiming = false;
      this.setAiming(true);
    }
  }

  /** Gun raised (the first frame of the firing clip) over whatever the legs do. */
  setAiming(on: boolean): void {
    if (on === this.aiming) return;
    this.aiming = on;
    if (on) void this.startOverlay(AIM_CLIP[this.stance], false);
    else if (this.overlay && this.overlay.timeLeft === Infinity) this.overlay.wanted = false;
  }

  /** A shot: the gun comes up and stays steady (no recoil on the body, the owner's call). */
  fire(): void {
    if (this.aiming) return;
    if (this.overlay && this.overlay.action === this.overlays.get(AIM_CLIP[this.stance])) {
      this.overlay.wanted = true;
      this.overlay.timeLeft = SHOT_RAISED_S;
    } else void this.startOverlay(AIM_CLIP[this.stance], false, SHOT_RAISED_S);
  }

  /**
   * Talking (the mic held): the talking gestures, looping over the arms and head while the
   * legs keep doing whatever they do; they ease out when the mic is let go. Aiming and shots
   * take the arms first.
   */
  setTalking(on: boolean): void {
    if (on === this.talking) return;
    this.talking = on;
    if (on && !this.aiming && !this.overlay)
      void this.startOverlay('talking', true, Infinity, true);
    else if (!on && this.overlay && this.overlay.action === this.overlays.get('talking'))
      this.overlay.wanted = false;
  }

  /** A punch over locomotion (the arms; the legs keep walking). */
  punch(): void {
    void this.startOverlay('punching', true, 0.7);
  }

  /** A flinch over locomotion when hit (its start only). */
  hit(): void {
    void this.startOverlay('hit_reaction', true, HIT_SECONDS);
  }

  private async startOverlay(name: string, play: boolean, seconds = Infinity, loop = false) {
    const clip = await this.clip(name);
    if (!clip) return;
    // Talking stopped while its clip was still loading.
    if (name === 'talking' && !this.talking) return;
    let action = this.overlays.get(name);
    if (!action) {
      action = this.mixer.clipAction(halfClip(clip, true));
      if (loop) action.setLoop(THREE.LoopRepeat, Infinity);
      else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.overlays.set(name, action);
    }
    const prev = this.overlay;
    if (prev && prev.action !== action) prev.action.stop();
    action.reset();
    // Aiming holds the clip's first frame; a shot plays it through once.
    action.timeScale = play ? 1 : 0;
    action.play();
    this.overlay = {
      action,
      weight: prev && prev.action === action ? prev.weight : prev ? 1 : 0,
      wanted: true,
      timeLeft: seconds,
    };
  }

  update(dt: number, speed: number, gait?: 'walk' | 'run', angle?: number): void {
    if (this.oneShot && !this.held && speed > 0.5) this.oneShot.wanted = false;

    // Locomotion: pick the clip, falling back to unarmed while the stance's pack loads.
    const set = SETS[this.stance];
    const directional = this.stance !== 'unarmed' ? angle : undefined;
    this.move = pickMove(this.move, speed, gait, directional);
    const name =
      set[this.move]?.find((n) => this.clips.has(n)) ??
      SETS.unarmed[
        this.move === 'idle' ? 'idle' : this.move.startsWith('run') ? 'run' : 'walk'
      ]?.find((n) => this.clips.has(n)) ??
      null;
    if (name && name !== this.current) {
      const layer = this.layer(name);
      if (!this.loco.has(name)) {
        layer.lower.reset().play();
        layer.upper.reset().play();
        this.loco.set(name, 0);
      }
      this.current = name;
    }

    // Weights.
    const step = dt / FADE;
    for (const [clip, w] of this.loco) {
      const next = clip === this.current ? Math.min(1, w + step) : Math.max(0, w - step);
      if (next === 0 && clip !== this.current) {
        const layer = this.layered.get(clip);
        layer?.lower.stop();
        layer?.upper.stop();
        this.loco.delete(clip);
      } else {
        this.loco.set(clip, next);
      }
    }
    const o = this.ramp(this.overlay, dt, OVERLAY_IN, OVERLAY_OUT);
    if (this.overlay && o === 0 && !this.overlay.wanted) {
      this.overlay.action.stop();
      this.overlay = null;
      // A flinch ended while aiming: raise the gun again; a punch while talking: talk on.
      if (this.aiming) void this.startOverlay(AIM_CLIP[this.stance], false);
      else if (this.talking) void this.startOverlay('talking', true, Infinity, true);
    }
    const f = this.ramp(this.oneShot, dt, FADE, FADE);
    if (this.oneShot && f === 0 && !this.oneShot.wanted) {
      this.oneShot.action.stop();
      this.oneShot = null;
    }
    // Walked off mid-way out of the car: on foot.
    if (this.seat === 'exit' && !this.oneShot?.wanted) this.seat = null;
    for (const [clip, w] of this.loco) {
      const layer = this.layered.get(clip);
      if (!layer) continue;
      layer.lower.setEffectiveWeight(w * (1 - f));
      layer.upper.setEffectiveWeight(w * (1 - f) * (1 - o));
      const authored = CLIP_SPEED[clip];
      const scale = authored ? THREE.MathUtils.clamp(speed / authored, 0.5, 1.8) : 1;
      layer.lower.timeScale = scale;
      layer.upper.timeScale = scale;
    }
    this.overlay?.action.setEffectiveWeight(o * (1 - f));
    this.oneShot?.action.setEffectiveWeight(f);
    // Last frame's bend off first: a bone no clip poses this frame would keep it, and bend more
    // and more each frame.
    this.spine?.forEach((bone, i) => {
      const was = this.bent[i];
      if (was && bone.quaternion.equals(was))
        bone.quaternion.copy(this.unbent[i] as THREE.Quaternion);
    });
    this.mixer.update(dt);
    this.bendSpine(dt);
    this.foldShins();
  }

  /**
   * At the wheel the shins fold away at the knee. The Driving clip sits on a chair, higher than
   * any car's seat: drawn in the car, its legs went through the floor and showed under it. The
   * dashboard hides the knees down in every car, so nobody sees them gone.
   */
  private foldShins() {
    const folded = this.seat === 'drive';
    if (folded === this.shinsFolded) return;
    this.shinsFolded = folded;
    this.shins ??= ['Left', 'Right'].flatMap((side) => {
      const bone = this.root.getObjectByName(`mixamorig${side}Leg`);
      return bone ? [bone] : [];
    });
    for (const bone of this.shins) bone.scale.setScalar(folded ? 0.001 : 1);
  }

  /** Bends the spine towards `pitch` while aiming (eased), after the clips have posed it. */
  private bendSpine(dt: number) {
    // Three quarters of the aim: the arms and the gun's own raise do the rest.
    const want = this.aiming ? THREE.MathUtils.clamp(this.pitch * 0.75, -0.7, 0.7) : 0;
    this.shownPitch += (want - this.shownPitch) * Math.min(1, dt * 10);
    if (Math.abs(this.shownPitch) < 0.002) return;
    this.spine ??= ['Spine', 'Spine1', 'Spine2']
      .map((n) => this.root.getObjectByName(`mixamorig${n}`) ?? this.root.getObjectByName(n))
      .filter((b): b is THREE.Object3D => b !== undefined);
    if (this.spine.length === 0) return;
    this.root.updateMatrixWorld(true);
    // About the character's own left-right axis (its +x), a share per bone, in each bone's frame.
    BEND_AXIS.set(1, 0, 0).applyQuaternion(this.root.getWorldQuaternion(BEND_Q)).normalize();
    const share = -this.shownPitch / this.spine.length;
    for (const [i, bone] of this.spine.entries()) {
      const parent = bone.parent;
      if (!parent) continue;
      (this.unbent[i] ??= new THREE.Quaternion()).copy(bone.quaternion);
      parent.getWorldQuaternion(BEND_PARENT);
      // The world turn, seen from the parent: q' = P⁻¹ · turn · P · q.
      BEND_TURN.setFromAxisAngle(BEND_AXIS, share);
      BEND_LOCAL.copy(BEND_PARENT).invert().multiply(BEND_TURN).multiply(BEND_PARENT);
      bone.quaternion.premultiply(BEND_LOCAL);
      (this.bent[i] ??= new THREE.Quaternion()).copy(bone.quaternion);
      // Its children follow the turned bone this frame.
      bone.updateMatrixWorld(true);
    }
  }

  private ramp(r: Ramp | null, dt: number, fadeIn: number, fadeOut: number): number {
    if (!r) return 0;
    r.timeLeft -= dt;
    if (r.timeLeft <= 0) r.wanted = false;
    r.weight = r.wanted
      ? Math.min(1, r.weight + dt / fadeIn)
      : Math.max(0, r.weight - dt / fadeOut);
    return r.weight;
  }

  private layer(name: string): Layered {
    let layer = this.layered.get(name);
    if (!layer) {
      const clip = this.clips.get(name) as THREE.AnimationClip;
      layer = {
        lower: this.mixer.clipAction(halfClip(clip, false)),
        upper: this.mixer.clipAction(halfClip(clip, true)),
      };
      this.layered.set(name, layer);
    }
    return layer;
  }

  /** Bandaging or swallowing medicine over the arms (patchup.ts), baked the first time. */
  async patchUp(kind: CareGesture): Promise<number> {
    if (!this.clips.has(kind)) {
      const idle = (await this.clip('standing_idle')) ?? this.clips.get('idle');
      const clip = idle && bakeGesture(this.root, idle, kind);
      if (clip) this.clips.set(kind, clip);
    }
    if (!this.clips.has(kind)) return 0;
    await this.startOverlay(kind, true, CARE_SECONDS[kind]);
    return CARE_SECONDS[kind];
  }

  /** Plays a full-body clip over everything until the character moves (emotes, dances). */
  async play(name: string, repeat = true): Promise<boolean> {
    const action = await this.full(name);
    if (!action) return false;
    action.setLoop(repeat ? THREE.LoopRepeat : THREE.LoopOnce, repeat ? Infinity : 1);
    action.clampWhenFinished = !repeat;
    this.startOneShot(action);
    return true;
  }

  /**
   * A jump (the player left the ground going up): the whole body, from the clip's takeoff,
   * at once (no fade: it's over in under a second); landing on the move hands back to running.
   */
  jump(): void {
    void this.full('jump').then((action) => {
      if (!action) return;
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      this.startOneShot(action, 1);
      action.time = JUMP_TAKEOFF;
    });
  }

  /** Plays a full-body clip once and holds its last frame until stop() (the knock-out fall). */
  async hold(name: string, rate = 1): Promise<boolean> {
    const action = await this.full(name);
    if (!action) return false;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    this.startOneShot(action);
    action.timeScale = rate;
    this.held = true;
    return true;
  }

  /** Straight to a clip's last frame, and held there (lying in a hospital bed). */
  async lie(name: string): Promise<void> {
    if (!(await this.hold(name))) return;
    const action = this.oneShot?.action;
    if (action) action.time = action.getClip().duration;
  }

  /** Up from a held fall: the clip run backwards, then back to whatever the legs do. */
  getUp(seconds: number): void {
    const action = this.oneShot?.action;
    if (!action || !this.held) return this.stop();
    this.held = false;
    const duration = action.getClip().duration;
    action.paused = false;
    action.enabled = true;
    action.time = duration;
    action.timeScale = -duration / seconds;
  }

  /** Down onto a chair, and sitting until stand() or stop(). */
  async sit(): Promise<void> {
    const ask = ++this.seatAsk;
    const [down] = await Promise.all([this.full('stand_to_sit'), this.full('sitting_idle')]);
    if (ask !== this.seatAsk || !down) return;
    this.sitting = true;
    down.setLoop(THREE.LoopOnce, 1);
    down.clampWhenFinished = true;
    this.startOneShot(down);
    down.timeScale = SIT_SPEED;
    this.held = true;
  }

  /** Up from a chair; walking off cuts it short. */
  async stand(): Promise<void> {
    const ask = ++this.seatAsk;
    this.sitting = false;
    const up = await this.full('sit_to_stand');
    if (ask !== this.seatAsk) return;
    if (!up) return this.stop();
    up.setLoop(THREE.LoopOnce, 1);
    up.clampWhenFinished = false;
    this.startOneShot(up, 1);
    up.timeScale = SIT_SPEED;
  }

  stop(): void {
    this.held = false;
    this.seat = null;
    this.sitting = false;
    this.seatAsk += 1;
    if (this.oneShot) this.oneShot.wanted = false;
  }

  /** Into a car at the driver's door: the end of Getting in, then the wheel. */
  async getIn(): Promise<void> {
    if (!SEAT.doors) return this.drive();
    const ask = ++this.seatAsk;
    const action = await this.full('entering_car');
    if (ask !== this.seatAsk) return;
    if (!action) return void this.drive();
    this.seat = 'enter';
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    this.startOneShot(action);
    action.time = SEAT.enterFrom;
    action.timeScale = SEAT.enterSpeed;
    this.held = true;
  }

  /** At the wheel, until getOut() or stop(). */
  async drive(): Promise<void> {
    const ask = ++this.seatAsk;
    const action = await this.full('driving');
    if (ask !== this.seatAsk || !action) return;
    this.seat = 'drive';
    action.setLoop(THREE.LoopRepeat, Infinity);
    // Straight on from getting in (no fade): the two meet in the same seated pose.
    this.startOneShot(action, this.oneShot ? 1 : undefined);
    this.held = true;
  }

  /** Out of the driver's door; moving off ends it. */
  async getOut(): Promise<void> {
    if (!SEAT.doors) return this.stop();
    const ask = ++this.seatAsk;
    const action = await this.full('exiting_car');
    if (ask !== this.seatAsk) return;
    if (!action) return void (this.seat = null);
    this.seat = 'exit';
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    this.startOneShot(action, this.oneShot ? 1 : undefined);
    action.timeScale = SEAT.exitSpeed;
  }

  private async full(name: string): Promise<THREE.AnimationAction | undefined> {
    const clip = await this.clip(name);
    if (!clip) return undefined;
    let action = this.fulls.get(name);
    if (!action) {
      action = this.mixer.clipAction(clip);
      this.fulls.set(name, action);
    }
    return action;
  }

  private startOneShot(action: THREE.AnimationAction, weight?: number) {
    const prev = this.oneShot;
    if (prev && prev.action !== action) prev.action.stop();
    action.reset().play();
    action.timeScale = 1;
    this.oneShot = {
      action,
      weight: weight ?? (prev ? prev.weight : 0),
      wanted: true,
      timeLeft: Infinity,
    };
    this.held = false;
  }
}
