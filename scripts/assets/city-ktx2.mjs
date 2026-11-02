#!/usr/bin/env node
/**
 * The city's surface textures (public/assets/textures/*.webp) as KTX2 beside them (Phase 2,
 * D-38): Basis ETC1S (normal maps at a higher quality), all with mipmaps.
 * KTX2 stays compressed on the GPU: a quarter of the video memory of the decoded WebP or less,
 * which matters on phones. Images are stored flipped, so the game samples exactly what it did from the
 * WebP (which the browser flips on upload). The WebP files stay as the fallback.
 *
 *   node scripts/assets/city-ktx2.mjs     (KTX-Software 4.4: `ktx` on PATH or in KTX_HOME)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'apps/client/public/assets/textures');
const ktxHome = process.env.KTX_HOME ?? join(process.env.HOME ?? '', '.local/ktx-4.4.2');
const ktx = existsSync(join(ktxHome, 'bin/ktx')) ? join(ktxHome, 'bin/ktx') : 'ktx';
const tmp = mkdtempSync(join(tmpdir(), 'city-ktx2-'));
let before = 0;
let after = 0;
try {
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.webp'))
    .sort()) {
    const src = join(dir, file);
    const png = join(tmp, file.replace(/\.webp$/, '.png'));
    const out = join(dir, file.replace(/\.webp$/, '.ktx2'));
    await sharp(src).flip().ensureAlpha().png().toFile(png);
    const normal = file.includes('_normal');
    const colour = file.includes('_color');
    const args = [
      'create',
      '--format',
      colour ? 'R8G8B8A8_SRGB' : 'R8G8B8A8_UNORM',
      // Normal and roughness maps are data: without this, ktx treats the PNG as sRGB and converts
      // it to linear, which tilts every normal and shifts roughness.
      ...(colour ? [] : ['--assign-tf', 'linear']),
      '--generate-mipmap',
      // ETC1S throughout (normals at a higher quality): UASTC normals were crisper but doubled
      // the download, which a first visit on mobile data can't afford.
      '--encode',
      'basis-lz',
      '--clevel',
      '2',
      '--qlevel',
      normal ? '230' : '160',
      png,
      out,
    ];
    execFileSync(ktx, args, { stdio: 'pipe' });
    before += statSync(src).size;
    after += statSync(out).size;
    console.log(file, '→', `${Math.round(statSync(out).size / 1024)} KB`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`WebP ${(before / 1e6).toFixed(1)} MB, KTX2 ${(after / 1e6).toFixed(1)} MB`);
