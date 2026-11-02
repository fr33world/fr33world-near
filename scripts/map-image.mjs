#!/usr/bin/env node
/**
 * Draws the map's picture: the whole island from straight above at midday, from the game
 * itself (Game.ts `?mapshot`: an orthographic camera, every tile in full detail, no haze),
 * into apps/client/public/map/island.webp. The minimap and the island map show it, with their
 * labels drawn over it in the game (so they stay sharp). Run again when the city changes.
 *   (dev server running on :5199)  node scripts/map-image.mjs [size=2048]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const size = Number(process.argv[2] ?? 2048);
const png = join(root, '.raw/island-map.png');
mkdirSync(join(root, '.raw'), { recursive: true });
execFileSync(
  'node',
  [
    join(root, 'scripts/shot.mjs'),
    'http://127.0.0.1:5199/?fly&offline&mapshot&t=12.5&q=high&shot&perf=0',
    png,
    String(size),
    String(size),
    '20000',
    // Nothing but the city: the HUD hidden.
    "document.head.insertAdjacentHTML('beforeend','<style>#root > :not(canvas){display:none!important}</style>')",
  ],
  { stdio: 'inherit', env: { ...process.env, SHOT_READY_MS: '600000' } },
);
const out = join(root, 'apps/client/public/map/island.webp');
mkdirSync(join(root, 'apps/client/public/map'), { recursive: true });
await sharp(png).webp({ quality: 80 }).toFile(out);
rmSync(png);
console.log(`wrote ${out}`);
