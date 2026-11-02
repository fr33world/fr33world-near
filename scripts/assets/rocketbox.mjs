#!/usr/bin/env node
/**
 * Builds the game's characters from Microsoft Rocketbox (MIT): every face and outfit listed in
 * packages/shared character.ts, and the animation packs retargeted onto their skeleton.
 *
 *   node scripts/assets/rocketbox-download.mjs   (once: the raw avatars into .raw/rocketbox)
 *   node scripts/assets/rocketbox.mjs [--force] [--masks] [id ...]
 *
 * For each avatar (Blender, scripts/blender/): convert_rocketbox.py splits it into a face and an
 * outfit at three levels of detail; rocketbox_masks.py draws the recolouring masks. The parts
 * the game uses go to apps/client/public/assets/characters/ (textures to KTX2 by optimize.mjs),
 * with characters/rocketbox.json (each avatar's skin colour and clothes luminance, for the
 * shader). The four animation packs are retargeted onto the first male outfit's skeleton (they
 * share one configuration). Rewrites the Rocketbox section of assets/registry.yaml. --masks
 * only redraws the masks (and rocketbox.json).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROCKETBOX_FACES, ROCKETBOX_OUTFITS } from '../../packages/shared/src/character.ts';

const root = resolve(import.meta.dirname, '../..');
const raw = join(root, '.raw/rocketbox');
const work = join(root, '.raw/rocketbox-out');
const chars = join(root, 'apps/client/public/assets/characters');
const anims = join(root, 'apps/client/public/assets/animations');
const blender = process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const force = process.argv.includes('--force');
const masksOnly = process.argv.includes('--masks');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/** Where each outfit shows skin besides hands and neck (from the avatars' pictures). */
const BARE = {
  m01: 'arms,legs',
  m09: 'arms',
  m16: 'arms',
  f01: 'arms',
  f02: 'legs',
  f03: 'arms',
  f08: 'arms',
  f11: 'legs',
  f12: 'legs',
  f13: 'arms',
  f15: 'legs',
  f17: 'arms',
};
const avatarName = (id) => `${id[0] === 'm' ? 'Male' : 'Female'}_Adult_${id.slice(1)}`;
const faces = new Set(Object.values(ROCKETBOX_FACES).flat());
const outfits = new Set(Object.values(ROCKETBOX_OUTFITS).flat());
const ids = [...new Set([...faces, ...outfits])].filter((id) => !only.length || only.includes(id));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 6).join(' ')} failed:\n${(r.stdout ?? '').slice(-2000)}\n${r.stderr ?? ''}`,
    );
  }
  return r.stdout;
}
const py = (script, args) =>
  run(blender, [
    '-b',
    '--factory-startup',
    '--python',
    join(root, 'scripts/blender', script),
    '--',
    ...args,
  ]);

mkdirSync(work, { recursive: true });
mkdirSync(chars, { recursive: true });
const shipped = [];

for (const id of ids) {
  const fbx = join(raw, avatarName(id), `${avatarName(id)}.fbx`);
  if (!existsSync(fbx)) throw new Error(`${fbx} missing: run rocketbox-download.mjs first`);
  const parts = [...(faces.has(id) ? ['face'] : []), ...(outfits.has(id) ? ['outfit'] : [])];
  if (masksOnly) {
    py('rocketbox_masks.py', [fbx, work, id, BARE[id] ?? 'none']);
    for (const p of parts) {
      copyFileSync(join(work, `rb_${id}_${p}.mask.png`), join(chars, `rb_${id}_${p}.mask.png`));
      shipped.push(`rb_${id}_${p}`);
    }
    console.log(`${id}: masks`);
    continue;
  }
  const done = parts.every((p) => existsSync(join(chars, `rb_${id}_${p}.glb`)));
  if (done && !force) {
    for (const p of parts) shipped.push(`rb_${id}_${p}`);
    continue;
  }
  py('convert_rocketbox.py', [fbx, work, id]);
  py('rocketbox_masks.py', [fbx, work, id, BARE[id] ?? 'none']);
  for (const p of parts) {
    for (const suffix of ['', '.lod1', '.lod2']) {
      copyFileSync(
        join(work, `rb_${id}_${p}${suffix}.glb`),
        join(chars, `rb_${id}_${p}${suffix}.glb`),
      );
    }
    copyFileSync(join(work, `rb_${id}_${p}.mask.png`), join(chars, `rb_${id}_${p}.mask.png`));
    shipped.push(`rb_${id}_${p}`);
  }
  // Textures to KTX2, mesh geometry compressed (optimize.mjs; budgets by level of detail).
  run('node', [
    join(root, 'scripts/assets/optimize.mjs'),
    ...parts.flatMap((p) =>
      ['', '.lod1', '.lod2'].map((s) => join(chars, `rb_${id}_${p}${s}.glb`)),
    ),
  ]);
  console.log(`${id}: ${parts.join(' and ')}`);
}
// Each avatar's skin colour (sRGB) and clothes regions' luminance, for the shader.
const tones = {};
for (const id of [...new Set([...faces, ...outfits])].sort()) {
  const file = join(work, `rb_${id}.skin.json`);
  if (existsSync(file)) tones[id] = JSON.parse(readFileSync(file, 'utf8'));
}
writeFileSync(join(chars, 'rocketbox.json'), `${JSON.stringify(tones, null, 2)}\n`);
run('pnpm', ['exec', 'prettier', '--write', join(chars, 'rocketbox.json')]);

// The animation packs, onto the first male outfit's skeleton (from the work copy: the shipped
// one is compressed).
const rig = join(work, `rb_${ROCKETBOX_OUTFITS.male[0]}_outfit.glb`);
if (!masksOnly && (!only.length || force)) {
  for (const pack of [
    'core',
    'combat',
    'pistol',
    'dances',
    'moves',
    'social',
    'vehicle',
    'rest',
    'rifle',
  ]) {
    run('node', [
      join(root, 'scripts/assets/retarget-rocketbox.mjs'),
      rig,
      join(anims, `humanoid_${pack}.glb`),
      join(anims, `rocketbox_${pack}.glb`),
    ]);
    console.log(`animations: rocketbox_${pack}`);
  }
}

// Registry: one entry per shipped part and per pack.
const registryPath = join(root, 'assets/registry.yaml');
const begin = '# BEGIN rocketbox (generated by scripts/assets/rocketbox.mjs)';
const end = '# END rocketbox';
const today = new Date().toISOString().slice(0, 10);
const entry = (id, file, cls, source, notes) =>
  [
    `  - id: ${id}`,
    `    file: ${file}`,
    `    class: ${cls}`,
    `    source_url: ${source}`,
    `    source_name: 'Microsoft Rocketbox avatar library'`,
    `    author: 'Microsoft'`,
    `    license: { name: MIT, url: 'https://github.com/microsoft/Microsoft-Rocketbox/blob/master/LICENSE.md', verified_at: '${today}' }`,
    '    license_snapshot: rocketbox-mit.txt',
    `    notes: '${notes.replaceAll("'", "''")}'`,
  ].join('\n');
const list = [...new Set(shipped)].sort();
const section = [
  begin,
  ...list.map((name) => {
    const [, id, part] = name.split('_');
    return entry(
      name,
      `characters/${name}.glb`,
      'character',
      `https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Adults/${avatarName(id)}`,
      `The ${part} of ${avatarName(id)} (scripts/blender/convert_rocketbox.py): LODs .lod1/.lod2, KTX2 textures, recolouring mask ${name}.mask.png.`,
    );
  }),
  ...['core', 'combat', 'pistol', 'dances', 'moves', 'social', 'vehicle', 'rest', 'rifle'].map(
    (p) =>
      entry(
        `rocketbox_${p}`,
        `animations/rocketbox_${p}.glb`,
        'animation',
        'https://github.com/microsoft/Microsoft-Rocketbox',
        `humanoid_${p} (Mixamo clips, see that entry) retargeted onto the Rocketbox skeleton by scripts/assets/retarget-rocketbox.mjs.`,
      ),
  ),
  `  ${end}`,
].join('\n');
let registry = readFileSync(registryPath, 'utf8');
const at = registry.indexOf(begin);
registry =
  at >= 0
    ? registry.slice(0, at) +
      section.trimStart() +
      registry.slice(registry.indexOf(end, at) + end.length)
    : `${registry.trimEnd()}\n  ${section.trimStart()}\n`;
writeFileSync(registryPath, registry);
console.log(`registry: ${list.length} parts`);
