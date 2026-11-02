/**
 * The game's sounds (Phase 3), all CC0 (assets/registry.yaml) or made here, and only from what
 * players actually do (owner, 2026-10-30: no recorded city noise, there's no traffic to make
 * it): the player's footsteps (concrete, grass in the hills), the car they drive, and other
 * players nearby, placed where they are: their cars and their footsteps. (Their voices are
 * voice.ts.) Each car model has its own engine (shared HANDLING: pitch, gears, loudness), its
 * revs climbing through the gears and dropping at each shift; tyres squeal when the car
 * slides or brakes hard, a crash thuds, and the horn (H) is heard by everyone near. Effects
 * play through the effects level (audio.ts, which also has the menus' music), so the settings
 * apply.
 */
import { districtAt } from '@fr33world/city';
import { FLAG, MODE } from '@fr33world/protocol';
import { engineRevs, handlingOf } from '@fr33world/shared';
import type * as THREE from 'three';
import { WEAPON } from '@fr33world/protocol';
import { audioContext, effectsBus, sound } from '../audio.ts';

/** Our own shots' level, and how far others' carry: full within NEAR, gone by FAR (m). */
const GUN_LEVEL = 0.7;
const GUN_NEAR_M = 14;
const GUN_FAR_M = 450;

/** A placed source: where in the city it sounds from, fading with distance. */
function placed(ctx: AudioContext, refDistance: number, maxDistance: number): PannerNode {
  return new PannerNode(ctx, {
    panningModel: 'equalpower',
    distanceModel: 'inverse',
    refDistance,
    maxDistance,
    rolloffFactor: 1.4,
  });
}

function moveTo(p: PannerNode | null, at: THREE.Vector3, t: number) {
  p?.positionX.setTargetAtTime(at.x, t, 0.05);
  p?.positionY.setTargetAtTime(at.y + 0.5, t, 0.05);
  p?.positionZ.setTargetAtTime(at.z, t, 0.05);
}

let noise: AudioBuffer | null = null;
/** Two seconds of white noise, made once (tyres, crashes). */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noise) return noise;
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
  return noise;
}

/** Tyres squealing: noise through a narrow band, as loud as the slide. */
class Squeal {
  private readonly src: AudioBufferSourceNode;
  private readonly gain: GainNode;

  constructor() {
    const ctx = audioContext();
    this.src = ctx.createBufferSource();
    this.src.buffer = noiseBuffer(ctx);
    this.src.loop = true;
    const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1700, Q: 6 });
    const band2 = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2300, Q: 4 });
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.src.connect(band).connect(band2).connect(this.gain).connect(effectsBus());
    this.src.start();
  }

  set(level: number): void {
    this.gain.gain.setTargetAtTime(level * 0.9, audioContext().currentTime, 0.06);
  }

  stop(): void {
    this.gain.gain.setTargetAtTime(0, audioContext().currentTime, 0.05);
    window.setTimeout(() => this.src.stop(), 400);
  }
}

/** A car horn: two square tones a third apart, softened; sounds while held. */
class Horn {
  private readonly oscs: OscillatorNode[];
  private readonly gain: GainNode;
  readonly panner: PannerNode | null;

  constructor(hz: number, where: boolean) {
    const ctx = audioContext();
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const soft = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1900, Q: 0.7 });
    this.panner = where ? placed(ctx, 8, 120) : null;
    this.oscs = [hz, hz * 1.26].map((f) => {
      const o = new OscillatorNode(ctx, { type: 'square', frequency: f });
      o.connect(soft);
      o.start();
      return o;
    });
    const out = soft.connect(this.gain);
    (this.panner ? out.connect(this.panner) : out).connect(effectsBus());
    this.gain.gain.setTargetAtTime(0.16, ctx.currentTime, 0.015);
  }

  stop(): void {
    const ctx = audioContext();
    this.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    window.setTimeout(() => {
      for (const o of this.oscs) o.stop();
      (this.panner ?? this.gain).disconnect();
    }, 300);
  }
}

/** An engine's hum, looped exactly (a short WAV), its pitch and level set every frame. */
class Engine {
  private readonly src: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode | null;

  constructor(buffer: AudioBuffer, where: boolean) {
    const ctx = audioContext();
    this.src = ctx.createBufferSource();
    this.src.buffer = buffer;
    this.src.loop = true;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.panner = where ? placed(ctx, 6, 60) : null;
    const chain = this.panner
      ? this.src.connect(this.gain).connect(this.panner)
      : this.src.connect(this.gain);
    chain.connect(effectsBus());
    this.src.start();
  }

  /**
   * A car of model `id` at `speed` (m/s) on `throttle` (0–1): the revs through its gears set the
   * pitch (a gear change drops them quickly), the throttle and revs the level.
   */
  set(id: string, top: number, speed: number, throttle: number, loudness: number): void {
    const t = audioContext().currentTime;
    const { sound: voice } = handlingOf(id);
    const revs = engineRevs(speed, top, voice.gears, throttle);
    this.src.playbackRate.setTargetAtTime(voice.pitch * (0.55 + revs * 1.15), t, 0.05);
    this.gain.gain.setTargetAtTime(
      loudness * voice.loud * (0.3 + 0.35 * Math.max(0, throttle) + 0.35 * revs),
      t,
      0.08,
    );
  }

  stop(): void {
    this.gain.gain.setTargetAtTime(0, audioContext().currentTime, 0.1);
    window.setTimeout(() => {
      this.src.stop();
      (this.panner ?? this.gain).disconnect();
    }, 500);
  }
}

/** Nearby cars with their own engine sound, nearest first. */
const ENGINE_VOICES = 4;
const ENGINE_RANGE = 45;
const STEPS = { walk: 0.52, run: 0.33 };
/** Other players' footsteps: the nearest few within earshot. */
const STEP_VOICES = 6;
const STEP_RANGE = 24;

export interface SoundState {
  listener: THREE.Camera;
  /** The player on foot: where, how they move, on the ground or not. Null in a car. */
  walker: { position: THREE.Vector3; mode: number; grounded: boolean } | null;
  /**
   * The car the player drives: its model, speed (m/s), throttle (0–1), sideways slide (m/s),
   * braking or the handbrake on, and the horn held.
   */
  driving: {
    id: string;
    top: number;
    speed: number;
    throttle: number;
    slide: number;
    braking: boolean;
    handbrake: boolean;
    horn: boolean;
    /** False with an empty tank or a wrecked engine: silent. */
    running: boolean;
  } | null;
  /** Other cars: which model, where, how fast (m/s), and their flags (the horn). */
  cars: Iterable<{
    id: number;
    model: { id: string; top: number };
    pos: THREE.Vector3;
    speed: number;
    state: number;
  }>;
  /** Other players on foot: where, and how they move (MODE). */
  walkers: Iterable<{ id: number; pos: THREE.Vector3; mode: number }>;
}

export class GameSounds {
  private engineBuffer: AudioBuffer | null = null;
  private driven: Engine | null = null;
  private readonly nearby = new Map<number, Engine>();
  private squeal: Squeal | null = null;
  private horn: Horn | null = null;
  private readonly horns = new Map<number, Horn>();
  private steps: Record<'concrete' | 'grass', AudioBuffer[]> = { concrete: [], grass: [] };
  /** Gunshots by weapon (protocol WEAPON), the reload and the click of an empty gun. */
  private readonly gunshots = new Map<number, AudioBuffer>();
  private gunReload: AudioBuffer | null = null;
  private gunDry: AudioBuffer | null = null;
  private stepIn = 0;
  /** Other players' next footstep, by entity id (seconds). */
  private readonly theirSteps = new Map<number, number>();

  constructor() {
    void sound('engine.wav').then((b) => (this.engineBuffer = b));
    void sound('gun-pistol.mp3').then((b) => this.gunshots.set(WEAPON.HEAVY_PISTOL, b));
    void sound('gun-rifle.mp3').then((b) => this.gunshots.set(WEAPON.ASSAULT_RIFLE, b));
    void sound('gun-reload.mp3').then((b) => (this.gunReload = b));
    void sound('gun-dry.mp3').then((b) => (this.gunDry = b));
    for (const surface of ['concrete', 'grass'] as const) {
      void Promise.all([0, 1, 2, 3, 4].map((i) => sound(`step-${surface}-${i}.mp3`))).then(
        (b) => (this.steps[surface] = b),
      );
    }
  }

  update(dt: number, s: SoundState): void {
    const ctx = audioContext();
    const t = ctx.currentTime;
    this.placeListener(s.listener);

    // Footsteps at the walk's or the run's cadence.
    const w = s.walker;
    const moving = w && w.grounded && (w.mode === MODE.WALK || w.mode === MODE.RUN);
    if (w && moving) {
      this.stepIn -= dt;
      if (this.stepIn <= 0) {
        this.stepIn = w.mode === MODE.WALK ? STEPS.walk : STEPS.run;
        this.step(
          districtAt(w.position.x, w.position.z) === 'hills' ? 'grass' : 'concrete',
          w.mode,
        );
      }
    } else this.stepIn = 0.12;

    // Other players walking or running nearby, each at their own cadence, from where they are.
    const ears = s.listener.position;
    const walking = [...s.walkers]
      .filter(
        (p) => (p.mode === MODE.WALK || p.mode === MODE.RUN) && p.pos.distanceTo(ears) < STEP_RANGE,
      )
      .sort((a, b) => a.pos.distanceTo(ears) - b.pos.distanceTo(ears))
      .slice(0, STEP_VOICES);
    const heard = new Set<number>();
    for (const p of walking) {
      heard.add(p.id);
      // A random start, so two players side by side don't step in unison.
      const due = (this.theirSteps.get(p.id) ?? Math.random() * 0.3) - dt;
      if (due <= 0) {
        this.step(districtAt(p.pos.x, p.pos.z) === 'hills' ? 'grass' : 'concrete', p.mode, p.pos);
        this.theirSteps.set(p.id, p.mode === MODE.WALK ? STEPS.walk : STEPS.run);
      } else this.theirSteps.set(p.id, due);
    }
    for (const id of this.theirSteps.keys()) if (!heard.has(id)) this.theirSteps.delete(id);

    // The car being driven: engine, tyres, horn.
    const d = s.driving;
    if (d) {
      const speed = Math.abs(d.speed);
      const slide = Math.max(0, Math.min(1, (Math.abs(d.slide) - 2.5) / 6));
      const locked = d.handbrake && speed > 5 ? 0.7 : d.braking && speed > 12 ? 0.35 : 0;
      this.squeal ??= new Squeal();
      this.squeal.set(Math.min(1, slide + locked));
      if (d.horn) this.horn ??= new Horn(handlingOf(d.id).horn, false);
    } else if (this.squeal) {
      this.squeal.stop();
      this.squeal = null;
    }
    if (!d?.horn && this.horn) {
      this.horn.stop();
      this.horn = null;
    }
    // Other cars' horns, from where they are.
    const honking = new Set<number>();
    for (const c of s.cars) {
      if ((c.state & FLAG.HORN) === 0 || c.pos.distanceTo(ears) > 120) continue;
      honking.add(c.id);
      let h = this.horns.get(c.id);
      if (!h) {
        h = new Horn(handlingOf(c.model.id).horn, true);
        this.horns.set(c.id, h);
      }
      moveTo(h.panner, c.pos, t);
    }
    for (const [id, h] of this.horns)
      if (!honking.has(id)) {
        h.stop();
        this.horns.delete(id);
      }

    // The engine of the car being driven, and of the nearest moving cars around.
    if (!this.engineBuffer) return;
    if (d?.running) {
      this.driven ??= new Engine(this.engineBuffer, false);
      this.driven.set(d.id, d.top, d.speed, d.throttle, 0.55);
    } else if (this.driven) {
      this.driven.stop();
      this.driven = null;
    }
    const listener = s.listener.position;
    const near = [...s.cars]
      .filter((c) => Math.abs(c.speed) > 0.5 && c.pos.distanceTo(listener) < ENGINE_RANGE)
      .sort((a, b) => a.pos.distanceTo(listener) - b.pos.distanceTo(listener))
      .slice(0, ENGINE_VOICES);
    const keep = new Set(near.map((c) => c.id));
    for (const [id, e] of this.nearby) {
      if (!keep.has(id)) {
        e.stop();
        this.nearby.delete(id);
      }
    }
    for (const c of near) {
      let e = this.nearby.get(c.id);
      if (!e) {
        e = new Engine(this.engineBuffer, true);
        this.nearby.set(c.id, e);
      }
      moveTo(e.panner, c.pos, t);
      // Others' throttle isn't sent: a car under way is taken to be on it.
      e.set(c.model.id, c.model.top, c.speed, 0.6, 0.8);
    }
  }

  /** A footstep: the player's own, or at `at` (someone else's, placed in 3D). */
  private step(surface: 'concrete' | 'grass', mode: number, at?: THREE.Vector3) {
    const options = this.steps[surface];
    const buffer = options[Math.floor(Math.random() * options.length)];
    if (!buffer) return;
    const ctx = audioContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // A little different each time, and firmer when running.
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const g = ctx.createGain();
    g.gain.value = (surface === 'grass' ? 0.5 : 0.65) * (mode === MODE.RUN ? 1 : 0.7);
    if (at) {
      const panner = new PannerNode(ctx, {
        panningModel: 'equalpower',
        distanceModel: 'inverse',
        refDistance: 3,
        maxDistance: STEP_RANGE,
        rolloffFactor: 1.6,
        positionX: at.x,
        positionY: at.y,
        positionZ: at.z,
      });
      src.connect(g).connect(panner).connect(effectsBus());
    } else src.connect(g).connect(effectsBus());
    src.start();
  }

  /** The ears are the camera's. */
  private placeListener(camera: THREE.Camera) {
    const l = audioContext().listener;
    const t = audioContext().currentTime;
    const e = camera.matrixWorld.elements;
    // Forward is the camera's -z, up its +y.
    if (l.positionX) {
      l.positionX.setTargetAtTime(camera.position.x, t, 0.02);
      l.positionY.setTargetAtTime(camera.position.y, t, 0.02);
      l.positionZ.setTargetAtTime(camera.position.z, t, 0.02);
      l.forwardX.setTargetAtTime(-(e[8] ?? 0), t, 0.02);
      l.forwardY.setTargetAtTime(-(e[9] ?? 0), t, 0.02);
      l.forwardZ.setTargetAtTime(-(e[10] ?? 1), t, 0.02);
      l.upX.setTargetAtTime(e[4] ?? 0, t, 0.02);
      l.upY.setTargetAtTime(e[5] ?? 1, t, 0.02);
      l.upZ.setTargetAtTime(e[6] ?? 0, t, 0.02);
    } else {
      // Older Safari: the setter methods only.
      l.setPosition(camera.position.x, camera.position.y, camera.position.z);
      l.setOrientation(-(e[8] ?? 0), -(e[9] ?? 0), -(e[10] ?? 1), e[4] ?? 0, e[5] ?? 1, e[6] ?? 0);
    }
  }

  /** A gunshot: ours as heard from behind the gun, someone else's from where they stand. */
  shot(weapon: number, at?: THREE.Vector3): void {
    const buffer = this.gunshots.get(weapon);
    if (!buffer) return;
    const ctx = audioContext();
    const src = new AudioBufferSourceNode(ctx, { buffer });
    // No two shots quite alike, so a burst doesn't sound like a loop.
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    const gain = new GainNode(ctx, { gain: at ? 1 : GUN_LEVEL });
    src.connect(gain);
    if (at) {
      const pan = placed(ctx, GUN_NEAR_M, GUN_FAR_M);
      pan.positionX.value = at.x;
      pan.positionY.value = at.y;
      pan.positionZ.value = at.z;
      gain.connect(pan).connect(effectsBus());
    } else gain.connect(effectsBus());
    src.start();
  }

  /** The reload, or the click of an empty gun. */
  gun(what: 'reload' | 'dry'): void {
    const buffer = what === 'reload' ? this.gunReload : this.gunDry;
    if (!buffer) return;
    const ctx = audioContext();
    const src = new AudioBufferSourceNode(ctx, { buffer });
    src.connect(new GainNode(ctx, { gain: 0.5 })).connect(effectsBus());
    src.start();
  }

  /** A crash in the car the player drives: a thud and a crunch, as big as the damage (0–1). */
  crash(size: number): void {
    const ctx = audioContext();
    const t = ctx.currentTime;
    const level = Math.min(1, 0.35 + size * 2);
    const thud = new OscillatorNode(ctx, { type: 'sine', frequency: 120 });
    thud.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.9 * level, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    thud.connect(tg).connect(effectsBus());
    thud.start(t);
    thud.stop(t + 0.4);
    const crunch = ctx.createBufferSource();
    crunch.buffer = noiseBuffer(ctx);
    const low = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 900 + size * 2500 });
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.7 * level, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.3 + size * 0.4);
    crunch.connect(low).connect(cg).connect(effectsBus());
    crunch.start(t, Math.random());
    crunch.stop(t + 0.8);
  }

  /** A bright two-note chime for a reward (synthesised: nothing to download). */
  reward(): void {
    const ctx = audioContext();
    const t = ctx.currentTime;
    [880, 1318.5].forEach((hz, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = hz;
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.22, t + i * 0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.09 + 0.45);
      o.connect(g).connect(effectsBus());
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.5);
    });
  }

  dispose(): void {
    this.driven?.stop();
    this.squeal?.stop();
    this.horn?.stop();
    for (const h of this.horns.values()) h.stop();
    this.horns.clear();
    for (const e of this.nearby.values()) e.stop();
    this.nearby.clear();
  }
}
