/**
 * The player's settings, kept on this device: sound levels and the controls. Graphics live in
 * quality.ts (they need a reload). Changes apply at once, to everything listening.
 */

export interface PlayerSettings {
  /** Volumes, 0–1. */
  master: number;
  music: number;
  effects: number;
  /** Other players' voices. */
  voice: number;
  /** Look speed, as a multiple of the default (0.3–3). */
  lookSpeed: number;
  /** Looking up and down the other way round. */
  invertY: boolean;
  /** How far back the camera sits, as a multiple of its usual distance. */
  zoom: number;
}

export const DEFAULT_SETTINGS: PlayerSettings = {
  master: 0.9,
  music: 0.5,
  effects: 0.8,
  voice: 1,
  lookSpeed: 1,
  invertY: false,
  zoom: 1,
};

const KEY = 'fr33.settings';
const listeners = new Set<(s: PlayerSettings) => void>();
let current: PlayerSettings = load();

function load(): PlayerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PlayerSettings>;
    const s = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(s) as (keyof PlayerSettings)[]) {
      if (typeof saved[k] === typeof s[k]) Object.assign(s, { [k]: saved[k] });
    }
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function settings(): PlayerSettings {
  return current;
}

export function updateSettings(change: Partial<PlayerSettings>): void {
  current = { ...current, ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private browsing or full storage: still applies for this visit.
  }
  for (const l of listeners) l(current);
}

/** Calls `fn` now and on every change; returns the unsubscribe. */
export function onSettings(fn: (s: PlayerSettings) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => void listeners.delete(fn);
}
