#!/usr/bin/env node
/**
 * Downloads the Rocketbox avatars the game uses (packages/shared character.ts) into
 * .raw/rocketbox/<Avatar>/: the FBX and the colour, normal and opacity textures (the specular
 * maps aren't used). Files already there are kept. Raw files stay out of git.
 *   node scripts/assets/rocketbox-download.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROCKETBOX_FACES, ROCKETBOX_OUTFITS } from '../../packages/shared/src/character.ts';
import { UNIFORM_AVATARS } from '../../packages/shared/src/factions.ts';

const root = resolve(import.meta.dirname, '../..');
const RAW = 'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets/Avatars';
/** m04 → Male_Adult_04; a uniform's id → its avatar in Professions. */
export const avatarName = (id) =>
  UNIFORM_AVATARS[id] ?? `${id[0] === 'm' ? 'Male' : 'Female'}_Adult_${id.slice(1)}`;
const folder = (id) => (UNIFORM_AVATARS[id] ? 'Professions' : 'Adults');
const ids = [
  ...new Set([...Object.values(ROCKETBOX_FACES), ...Object.values(ROCKETBOX_OUTFITS)].flat()),
  ...Object.keys(UNIFORM_AVATARS),
];

// One request for the whole library: asking per avatar runs into GitHub's hourly limit.
const { tree } = await (
  await fetch(
    'https://api.github.com/repos/microsoft/Microsoft-Rocketbox/git/trees/master?recursive=1',
  )
).json();

for (const id of ids) {
  const name = avatarName(id);
  const dir = join(root, '.raw/rocketbox', name);
  mkdirSync(join(dir, 'Textures'), { recursive: true });
  const from = `${RAW}/${folder(id)}/${name}`;
  const get = async (url, to) => {
    if (existsSync(to)) return;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    writeFileSync(to, Buffer.from(await res.arrayBuffer()));
  };
  await get(`${from}/Export/${name}.fbx`, join(dir, `${name}.fbx`));
  const prefix = `Assets/Avatars/${folder(id)}/${name}/Textures/`;
  const list = tree
    .filter((t) => t.path.startsWith(prefix))
    .map((t) => ({ name: t.path.slice(prefix.length) }));
  for (const f of list) {
    if (/_specular\./.test(f.name)) continue;
    await get(`${from}/Textures/${f.name}`, join(dir, 'Textures', f.name));
  }
  console.log('downloaded', name);
}
