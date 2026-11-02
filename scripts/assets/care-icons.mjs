#!/usr/bin/env node
/**
 * The bag's item pictures (shared CARE), rendered by Blender (scripts/blender/care_icons.py),
 * trimmed and saved as small WebP in apps/client/public/ui/care.
 *   node scripts/assets/care-icons.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../..');
const blender = process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const out = join(root, 'apps/client/public/ui/care');
const stage = mkdtempSync(join(tmpdir(), 'care-icons-'));
mkdirSync(out, { recursive: true });
const run = spawnSync(
  blender,
  ['-b', '--factory-startup', '--python', join(root, 'scripts/blender/care_icons.py'), '--', stage],
  { encoding: 'utf8' },
);
if (run.status !== 0 || !/BUILT/.test(run.stdout)) {
  console.error(`${run.stdout}${run.stderr}`.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
for (const item of ['bandage', 'medicine']) {
  await sharp(join(stage, `${item}.png`))
    .trim({ threshold: 1 })
    .resize({ width: 168, height: 168, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 86, alphaQuality: 92 })
    .toFile(join(out, `${item}.webp`));
  console.log('care', item);
}
rmSync(stage, { recursive: true, force: true });
