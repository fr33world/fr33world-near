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

const root = resolve(import.meta.dirname, '../..');
const RAW =
  'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets/Avatars/Adults';
/** m04 → Male_Adult_04. */
export const avatarName = (id) => `${id[0] === 'm' ? 'Male' : 'Female'}_Adult_${id.slice(1)}`;
const ids = [
  ...new Set([...Object.values(ROCKETBOX_FACES), ...Object.values(ROCKETBOX_OUTFITS)].flat()),
];

for (const id of ids) {
  const name = avatarName(id);
  const dir = join(root, '.raw/rocketbox', name);
  mkdirSync(join(dir, 'Textures'), { recursive: true });
  const get = async (url, to) => {
    if (existsSync(to)) return;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    writeFileSync(to, Buffer.from(await res.arrayBuffer()));
  };
  await get(`${RAW}/${name}/Export/${name}.fbx`, join(dir, `${name}.fbx`));
  const list = await (
    await fetch(
      `https://api.github.com/repos/microsoft/Microsoft-Rocketbox/contents/Assets/Avatars/Adults/${name}/Textures`,
    )
  ).json();
  if (!Array.isArray(list)) throw new Error(`${name}: ${JSON.stringify(list).slice(0, 200)}`);
  for (const f of list) {
    if (/_specular\./.test(f.name)) continue;
    await get(`${RAW}/${name}/Textures/${f.name}`, join(dir, 'Textures', f.name));
  }
  console.log('downloaded', name);
}
