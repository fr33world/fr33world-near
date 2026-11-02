#!/usr/bin/env node
/**
 * Texture compression for the game's models (Phase 2 asset pipeline, decision D-38): every
 * texture becomes KTX2 (Basis Universal), which stays compressed on the GPU. WebP and PNG
 * unpack to full size there: a 2048² texture takes 22 MB of video memory instead of about 3.
 * Colour textures use ETC1S (small downloads); normal maps use UASTC (they show ETC1S
 * artefacts), capped at 1024². Only the textures change: meshes, skins and animations are written back as they
 * were, with meshopt geometry compression kept. Files already converted are skipped.
 *
 *   node scripts/assets/optimize.mjs [glb ...]     (default: every character model)
 *
 * Needs KTX-Software 4.3+ (`ktx` on PATH, or KTX_HOME; see README → Asset pipeline).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Mode, toktx } from '@gltf-transform/cli';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../..');
const ktxHome = process.env.KTX_HOME ?? join(process.env.HOME ?? '', '.local/ktx-4.4.2');
if (existsSync(join(ktxHome, 'bin/ktx')))
  process.env.PATH = `${join(ktxHome, 'bin')}:${process.env.PATH}`;

const NORMAL = /normal/i;
/** Parts that are small on screen (shoes, eyes, brows, lashes) get half the texture. */
const SMALL_PART = /shoe|eye|brow|lash/i;

/**
 * Texture budgets by detail level (the file's .lod1 / .lod2 suffix): normal maps carry fabric
 * folds that only show up close, so they shrink faster than colour and vanish at LOD2.
 */
function budgetFor(file) {
  if (/\.lod2\.glb$/.test(file)) return { normalMax: 0, colourMax: 512 };
  if (/\.lod1\.glb$/.test(file)) return { normalMax: 512, colourMax: 1024 };
  return { normalMax: 1024, colourMax: 2048 };
}

/** Removes normal maps from every material (far detail levels). */
function dropNormalMaps(doc) {
  for (const material of doc.getRoot().listMaterials()) {
    const tex = material.getNormalTexture();
    if (!tex) continue;
    material.setNormalTexture(null);
    if (tex.listParents().length <= 1) tex.dispose();
  }
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => resolve(f))
  : readdirSync(join(root, 'apps/client/public/assets/characters'))
      .filter((f) => f.endsWith('.glb'))
      .map((f) => join(root, 'apps/client/public/assets/characters', f));

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

let before = 0;
let after = 0;
for (const file of files) {
  const doc = await io.read(file);
  const textures = doc.getRoot().listTextures();
  if (textures.length === 0 || textures.every((t) => t.getMimeType() === 'image/ktx2')) {
    console.log(`skip  ${file.slice(root.length + 1)} (no textures to convert)`);
    continue;
  }
  const size = statSync(file).size;
  const { normalMax, colourMax } = budgetFor(file);
  if (normalMax === 0) dropNormalMaps(doc);
  await doc.transform(
    // The KTX encoder reads PNG or JPEG only; sizes are capped per detail level first.
    ...(normalMax
      ? [
          textureCompress({
            encoder: sharp,
            targetFormat: 'png',
            slots: NORMAL,
            resize: [normalMax, normalMax],
          }),
          textureCompress({
            encoder: sharp,
            targetFormat: 'png',
            slots: NORMAL,
            pattern: SMALL_PART,
            resize: [normalMax / 2, normalMax / 2],
          }),
        ]
      : []),
    textureCompress({
      encoder: sharp,
      targetFormat: 'png',
      pattern: SMALL_PART,
      resize: [512, 512],
    }),
    textureCompress({ encoder: sharp, targetFormat: 'png', resize: [colourMax, colourMax] }),
    toktx({ mode: Mode.ETC1S, quality: 192, slots: /^(?!normalTexture).*$/ }),
    toktx({ mode: Mode.UASTC, level: 2, zstd: 18, slots: NORMAL }),
  );
  await io.write(file, doc);
  const now = statSync(file).size;
  before += size;
  after += now;
  console.log(
    `done  ${file.slice(root.length + 1)}  ${(size / 1024).toFixed(0)} KB → ${(now / 1024).toFixed(0)} KB`,
  );
}
if (before) console.log(`total ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
