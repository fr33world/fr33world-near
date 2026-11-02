#!/usr/bin/env node
/**
 * The interface's character pictures, rendered from the game's own characters and clips
 * (apps/client pose.html, the dev server running): each emote in the emotes menu, and Luz,
 * the tutorial's guide, as a cut-out (clear background); and every car the dealership sells,
 * for its showroom. Trimmed and saved as small WebP in apps/client/public/ui.
 *
 *   node scripts/assets/ui-pictures.mjs [emotes|luz|cars]...   (all of them by default;
 *                                                              DEV_URL, default http://127.0.0.1:5199)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../..');
const dev = process.env.DEV_URL ?? 'http://127.0.0.1:5199';
const tmp = mkdtempSync(join(tmpdir(), 'ui-pictures-'));
const ui = join(root, 'apps/client/public/ui');
mkdirSync(join(ui, 'emotes'), { recursive: true });
mkdirSync(join(ui, 'tutorial'), { recursive: true });
mkdirSync(join(ui, 'cars'), { recursive: true });
const only = process.argv.slice(2);
const wanted = (what) => only.length === 0 || only.includes(what);

/** The cars for sale (shared CARS_FOR_SALE). */
const CARS = [
  'compact',
  'hatchback',
  'sedan',
  'wagon',
  'minivan',
  'pickup',
  'offroad',
  'suv',
  'coupe',
  'sport',
];

/** The emotes (protocol EMOTES), each at a telling moment of its clip. */
const EMOTES = [
  ['waving', 1.3],
  ['clapping', 0.55],
  ['laughing', 1.0],
  ['pointing', 1.3],
  ['standing_thumbs_up', 1.3],
  ['talking_1', 1.0],
  ['dancing', 1.6],
  ['hip_hop_dancing', 1.2],
  ['dancing_twerk', 1.0],
  ['snake_hip_hop', 4.2],
  ['step_hip_hop', 2.1],
];

function shoot(query, file, width, height) {
  execFileSync(
    'node',
    [
      join(root, 'scripts/shot.mjs'),
      `${dev}/pose.html?${query}`,
      file,
      String(width),
      String(height),
      '800',
    ],
    {
      env: { ...process.env, SHOT_TRANSPARENT: '1', SHOT_NO_TAP: '1', SHOT_READY_MS: '180000' },
      stdio: 'ignore',
    },
  );
}

// EMOTE_ONLY=clip,clip: just these (the others' files stay as they are).
const emoteOnly = process.env.EMOTE_ONLY?.split(',');
for (const [clip, sec] of wanted('emotes') ? EMOTES : []) {
  if (emoteOnly && !emoteOnly.includes(clip)) continue;
  const raw = join(tmp, `${clip}.png`);
  shoot(`look=m.0.0&clip=${clip}&sec=${sec}&view=full&turn=0.35`, raw, 420, 520);
  const out = join(ui, 'emotes', `${clip}.webp`);
  await sharp(raw)
    .trim({ threshold: 1 })
    .resize({ height: 240, width: 200, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 82, alphaQuality: 90 })
    .toFile(out);
  console.log('emote', clip);
}

if (wanted('luz')) {
  const raw = join(tmp, 'luz.png');
  shoot('look=f.5.9.0&clip=talking&sec=1.4&view=bust&turn=0.25', raw, 640, 640);
  await sharp(raw)
    .trim({ threshold: 1 })
    .resize({
      width: 300,
      height: 300,
      fit: 'cover',
      position: 'top',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 85, alphaQuality: 90 })
    .toFile(join(ui, 'tutorial', 'luz.webp'));
  console.log('luz');
}

for (const car of wanted('cars') ? CARS : []) {
  const raw = join(tmp, `${car}.png`);
  shoot(`car=${car}`, raw, 960, 480);
  await sharp(raw)
    .trim({ threshold: 1 })
    .resize({ width: 560, height: 260, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 84, alphaQuality: 90 })
    .toFile(join(ui, 'cars', `${car}.webp`));
  console.log('car', car);
}
rmSync(tmp, { recursive: true, force: true });
