/**
 * Graphics quality (technical-plan §3). The player picks Auto, Low, Medium, High or Ultra in
 * the settings (saved on the device); Auto picks a tier from the device. Whichever tier, the
 * game keeps the frame rate up by adjusting the rendering resolution (Game). `?q=<tier>`
 * overrides both and pins the resolution, for tests. Everything expensive reads its budget from here.
 */
export type Tier = 'low' | 'medium' | 'high' | 'ultra';
export type GraphicsSetting = 'auto' | Tier;
export const GRAPHICS_SETTINGS: GraphicsSetting[] = ['auto', 'low', 'medium', 'high', 'ultra'];

export interface Quality {
  tier: Tier;
  /** Chosen by Auto (shown in the stats overlay). */
  auto: boolean;
  /** Set by `?q=` (tests, screenshots): the resolution stays put, whatever the frame rate. */
  pinned: boolean;
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Half-size of the area around the camera target that casts sun shadows (m). */
  shadowRadius: number;
  /** Frames between shadow map updates (the sun moves slowly). */
  shadowEvery: number;
  anisotropy: number;
  /** Facade normal maps cost a texture fetch per pixel of every wall. */
  facadeNormals: boolean;
  /** Camera far plane / fog distance (m). */
  viewDistance: number;
  /** Re-render the sky into the environment map at most this often (ms). */
  envUpdateMs: number;
  /** Shortest time between frames (ms), 0 for as fast as the screen goes. */
  minFrameMs: number;
}

const TIERS: Record<Tier, Omit<Quality, 'tier' | 'auto' | 'pinned' | 'pixelRatio'>> = {
  low: {
    antialias: false,
    shadows: false,
    shadowMapSize: 1024,
    shadowRadius: 30,
    shadowEvery: 4,
    anisotropy: 2,
    facadeNormals: false,
    viewDistance: 1200,
    envUpdateMs: 8000,
    // An even 30 feels smoother than a ragged 40, and keeps a phone cooler for longer.
    minFrameMs: 33,
  },
  medium: {
    antialias: true,
    shadows: true,
    shadowMapSize: 1024,
    shadowRadius: 45,
    shadowEvery: 2,
    anisotropy: 4,
    facadeNormals: false,
    viewDistance: 2000,
    envUpdateMs: 4000,
    minFrameMs: 0,
  },
  high: {
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    shadowRadius: 70,
    shadowEvery: 1,
    anisotropy: 8,
    facadeNormals: true,
    viewDistance: 3000,
    envUpdateMs: 2000,
    minFrameMs: 0,
  },
  ultra: {
    antialias: true,
    shadows: true,
    shadowMapSize: 4096,
    shadowRadius: 110,
    shadowEvery: 1,
    anisotropy: 16,
    facadeNormals: true,
    viewDistance: 3600,
    envUpdateMs: 1000,
    minFrameMs: 0,
  },
};

/** Highest device-pixel ratio each tier renders at. */
const MAX_PIXEL_RATIO: Record<Tier, number> = { low: 1, medium: 1.5, high: 2, ultra: 2.5 };
const STORAGE_KEY = 'fr33.graphics';

export function isTouchDevice(): boolean {
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
}

const isSetting = (v: unknown): v is GraphicsSetting =>
  typeof v === 'string' && (GRAPHICS_SETTINGS as string[]).includes(v);

/** The player's choice: ?q= (tests), else what they saved, else Auto. */
export function graphicsSetting(): GraphicsSetting {
  const forced = new URLSearchParams(location.search).get('q');
  if (isSetting(forced)) return forced;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isSetting(saved)) return saved;
  } catch {
    // storage blocked (private mode): Auto
  }
  return 'auto';
}

export function saveGraphicsSetting(setting: GraphicsSetting): void {
  try {
    localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    // storage blocked: the choice lasts until reload only
  }
}

/** The GPU's name, when the browser shares it. */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '') : '';
  } catch {
    return '';
  }
}

/**
 * Budget phone GPUs. Memory and cores don't find these: a Tecno Spark 20 has eight cores and
 * plenty of memory, and a Mali-G52 far behind any iPhone's.
 */
const BUDGET_PHONE_GPU = /Mali-(T\d|G3\d|G5\d|G68)|Adreno\D*([3-5]\d\d|6[0-4]\d)|PowerVR/i;

/** Auto's starting tier: phones by GPU, memory and cores, laptops by GPU. */
export function autoTier(touch: boolean, memory: number, cores: number, gpu: string): Tier {
  if (touch) return memory <= 3 || cores <= 4 || BUDGET_PHONE_GPU.test(gpu) ? 'low' : 'medium';
  // Intel HD (not UHD): a 2015 MacBook Air's can't hold Medium's shadows and rooms.
  if (/\bHD Graphics/i.test(gpu)) return 'low';
  // Other Intel integrated graphics (not Iris Xe or Arc) struggle at High.
  if (/Intel/i.test(gpu) && !/Iris(\(R\))?\s*Xe|Arc/i.test(gpu)) return 'medium';
  return 'high';
}

/** Below this share of a tier's resolution the picture falls apart. */
export const MIN_RESOLUTION = 0.7;
/** A quarter of frames slower than this (ms): the device isn't keeping up. */
const SLOW_GAP_MS = 38;
/** Nine frames in ten faster than this (ms): there's room for more pixels. */
const FAST_GAP_MS = 24;
/** One frame in twenty longer than this (ms): bursts of stalls, the GPU falling behind. */
const STALL_GAP_MS = 80;
/** Coming back down this soon after going up (ms) means it couldn't hold it. */
const RAISE_FAILED_MS = 30_000;

/**
 * Holds the frame rate by rendering fewer pixels when it can't keep up, and more again when
 * there's room. Judged on the run of frames, not the average: a stall or two (a car coming into
 * view, a garbage collection) says nothing about how many pixels the device can draw, and read
 * as an average they dragged the resolution to the floor for good. A burst of them does: that's
 * the GPU falling behind, with the script left waiting for it.
 */
export class ResolutionGovernor {
  scale = 1;
  private readonly fastGapMs: number;
  /** Good checks in a row, and how many it takes to go up. */
  private good = 0;
  private needed = 3;
  private raisedAt = -Infinity;

  constructor(minFrameMs = 0) {
    this.fastGapMs = Math.max(FAST_GAP_MS, minFrameMs + 6);
  }

  /** One check's time between frames (ms); returns the scale to draw at. */
  check(gaps: number[], now: number): number {
    if (gaps.length < 10) return this.scale;
    const sorted = [...gaps].sort((a, b) => a - b);
    const at = (share: number) => sorted[Math.floor(share * (sorted.length - 1))] ?? 0;
    if (at(0.75) > SLOW_GAP_MS || at(0.95) > STALL_GAP_MS) {
      // It went up and couldn't hold it: leave it longer before trying again, so it doesn't
      // swing back and forth (each change reallocates the screen's buffers).
      if (now - this.raisedAt < RAISE_FAILED_MS) this.needed = Math.min(60, this.needed * 2);
      this.good = 0;
      this.scale = Math.max(MIN_RESOLUTION, this.scale * 0.88);
      return this.scale;
    }
    this.good = at(0.9) < this.fastGapMs ? this.good + 1 : 0;
    if (this.good >= this.needed && this.scale < 1) {
      this.good = 0;
      this.raisedAt = now;
      this.scale = Math.min(1, this.scale * 1.08);
    }
    return this.scale;
  }
}

export function detectQuality(): Quality {
  const setting = graphicsSetting();
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const tier =
    setting === 'auto'
      ? autoTier(isTouchDevice(), memory, navigator.hardwareConcurrency || 4, gpuName())
      : setting;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO[tier]);
  const pinned = isSetting(new URLSearchParams(location.search).get('q'));
  return { tier, auto: setting === 'auto', pinned, pixelRatio, ...TIERS[tier] };
}
