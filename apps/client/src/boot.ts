/**
 * The boot load (technical review §9, step 3): what every player needs before the first
 * screen past TAP TO PLAY. The game's code, the fonts, and the files the next minutes always
 * use (the characters' clips, the texture transcoder), fetched into the browser's cache with
 * byte-accurate progress (the CDN sends their sizes). The city itself loads on world entry.
 */
import { loadGame } from './loadGame.ts';

/** Fetched ahead into the HTTP cache (kept a day, public/_headers), so later loads are instant. */
const PREFETCH = [
  '/assets/animations/rocketbox_core.glb',
  '/assets/characters/rocketbox.json',
  '/basis/basis_transcoder.js',
  '/basis/basis_transcoder.wasm',
];
/** The game's code (Three.js, Rapier) counts as this many bytes: it has no streamed progress. */
const GAME_CODE_BYTES = 2_500_000;

export interface BootProgress {
  /** 0–1. */
  fraction: number;
  status: string;
}

/** Runs the boot load; rejects (to show a retry) if anything fails to arrive. */
export async function boot(onProgress: (p: BootProgress) => void): Promise<void> {
  const loaded = new Map<string, number>();
  const total = new Map<string, number>([['game', GAME_CODE_BYTES]]);
  let status = 'Getting Los Soles ready';
  const report = () => {
    let done = 0;
    let all = 0;
    for (const [k, size] of total) {
      all += size;
      done += Math.min(size, loaded.get(k) ?? 0);
    }
    onProgress({ fraction: all > 0 ? done / all : 0, status });
  };
  const game = loadGame().then(() => {
    loaded.set('game', GAME_CODE_BYTES);
    report();
  });
  const files = PREFETCH.map((url) =>
    prefetch(url, (got, size) => {
      if (size > 0) total.set(url, size);
      loaded.set(url, got);
      report();
    }),
  );
  report();
  await Promise.all([document.fonts.ready, game, ...files]);
  status = 'Ready';
  report();
}

/** Downloads `url` (into the HTTP cache), reporting bytes received and the size when known. */
async function prefetch(url: string, progress: (got: number, size: number) => void) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const size = Number(res.headers.get('content-length') ?? 0);
  progress(0, size);
  if (!res.body) return void progress(size, size);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    progress(got, Math.max(size, got));
  }
}
