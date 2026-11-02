/**
 * The game's one AudioContext and its mix: music and effects each through their own level,
 * both through the master level, all set from the player's settings. Browsers start the
 * context suspended until the player touches the page, and iOS also wants a sound started
 * inside that touch: TAP TO PLAY does both (unlockAudio), so sound can play from then on.
 * Also the menus' music (CC0, assets/registry.yaml); the game's own sounds are in
 * game/sounds.ts.
 */
import { onSettings } from './game/settings.ts';

let context: AudioContext | null = null;
let buses: { master: GainNode; music: GainNode; effects: GainNode } | null = null;

export function audioContext(): AudioContext {
  if (!context) {
    // iPhone: Web Audio counts as "ambient" sound by default, which the ring/silent switch
    // mutes, so players with the switch on heard nothing. As "playback" the game sounds like
    // a video does (Safari's Audio Session API; elsewhere this does nothing).
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    context = new AudioContext();
    const ctx = context;
    // Quiet while the game is out of sight (another tab or app), back when it returns.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void ctx.suspend();
      else void ctx.resume().catch(() => {});
    });
    // iOS leaves the sound "interrupted" after a call or a trip to another app, and won't
    // always resume it without a touch: the next touch brings it back.
    const wake = () => {
      if (ctx.state !== 'running' && !document.hidden) void ctx.resume().catch(() => {});
    };
    for (const type of ['pointerdown', 'touchend', 'keydown'])
      window.addEventListener(type, wake, { passive: true });
  }
  return context;
}

function mix() {
  if (buses) return buses;
  const ctx = audioContext();
  const master = ctx.createGain();
  const music = ctx.createGain();
  const effects = ctx.createGain();
  music.connect(master);
  effects.connect(master);
  master.connect(ctx.destination);
  buses = { master, music, effects };
  onSettings((s) => {
    const at = ctx.currentTime;
    // A short ramp, so dragging a slider doesn't click.
    master.gain.setTargetAtTime(s.master, at, 0.03);
    music.gain.setTargetAtTime(s.music, at, 0.03);
    effects.gain.setTargetAtTime(s.effects, at, 0.03);
  });
  return buses;
}

/** Where music plays into (its level, then the master level). */
export const musicBus = (): AudioNode => mix().music;
/** Where sound effects play into (footsteps, cars, the city). */
export const effectsBus = (): AudioNode => mix().effects;

/** Call from a tap or click handler. */
export function unlockAudio(): void {
  const ctx = audioContext();
  void ctx.resume().catch(() => {});
  // A one-sample silent sound, which is what unlocks output on iOS.
  const source = ctx.createBufferSource();
  source.buffer = ctx.createBuffer(1, 1, 22050);
  source.connect(ctx.destination);
  source.start(0);
}

const buffers = new Map<string, Promise<AudioBuffer>>();
/** Downloads and decodes a sound once (public/assets/audio). */
export function sound(name: string): Promise<AudioBuffer> {
  let b = buffers.get(name);
  if (!b) {
    b = fetch(`/assets/audio/${name}`)
      .then((r) => r.arrayBuffer())
      .then((data) => audioContext().decodeAudioData(data));
    b.catch(() => buffers.delete(name));
    buffers.set(name, b);
  }
  return b;
}

/**
 * A long recording looped as overlapping copies, each fading into the next: seamless whatever
 * silence the MP3 encoder left at the ends.
 */
export class Loop {
  readonly level: GainNode;
  private readonly name: string;
  private readonly fade: number;
  private next = 0;
  private current: GainNode | null = null;
  private timer = 0;
  private stopped = false;

  constructor(name: string, out: AudioNode, fade = 2) {
    this.name = name;
    this.fade = fade;
    this.level = audioContext().createGain();
    this.level.connect(out);
  }

  async start(): Promise<void> {
    const buffer = await sound(this.name);
    if (this.stopped) return;
    const ctx = audioContext();
    this.next = ctx.currentTime + 0.05;
    const schedule = () => {
      // Queue the next copy a few seconds ahead of its fade.
      while (!this.stopped && this.next < ctx.currentTime + 4) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, this.next);
        g.gain.linearRampToValueAtTime(1, this.next + this.fade);
        src.connect(g).connect(this.level);
        src.start(this.next);
        src.stop(this.next + buffer.duration);
        if (this.current) {
          this.current.gain.setValueAtTime(1, this.next);
          this.current.gain.linearRampToValueAtTime(0, this.next + this.fade);
        }
        this.current = g;
        this.next += buffer.duration - this.fade;
      }
    };
    schedule();
    this.timer = window.setInterval(schedule, 1000);
  }

  /** Fades out over `seconds`, then stops. */
  stop(seconds = 0.3): void {
    this.stopped = true;
    const t = audioContext().currentTime;
    this.level.gain.setValueAtTime(this.level.gain.value, t);
    this.level.gain.linearRampToValueAtTime(0, t + seconds);
    window.clearInterval(this.timer);
    window.setTimeout(() => this.level.disconnect(), seconds * 1000 + 100);
  }
}

/** The music under the menus: from TAP TO PLAY until the city is in view. */
let menuMusic: Loop | null = null;
export function playMenuMusic(): void {
  if (menuMusic) return;
  menuMusic = new Loop('music-menu.mp3', musicBus(), 3);
  void menuMusic.start();
}
export function stopMenuMusic(seconds = 3): void {
  menuMusic?.stop(seconds);
  menuMusic = null;
}
