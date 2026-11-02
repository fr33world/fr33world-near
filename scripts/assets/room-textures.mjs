#!/usr/bin/env node
/**
 * The rooms' surfaces (client city/interiors.ts): ambientCG (CC0) colour maps from the earlier
 * FreeWorld project's downloads, shrunk for phones. Rooms paint in their own light, so colour is
 * all they need. Fetched the first time someone goes in.
 *   node scripts/assets/room-textures.mjs <FreeWorld/.raw/textures>
 */
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../..');
const from = process.argv[2];
if (!from) {
  console.error('usage: room-textures.mjs <dir with ambientCG downloads>');
  process.exit(2);
}
/** name in the game → ambientCG id, and how much of its contrast to keep. */
const TEXTURES = {
  // Painted walls and a mopped floor: the rough plaster and the stains calmed right down.
  plaster: ['Plaster003', 0.32],
  tile: ['Tiles141', 0.5],
  wood_floor: ['WoodFloor051', 1],
  carpet: ['Carpet012', 1],
  ceiling: ['OfficeCeiling001', 1],
  wood: ['Wood066', 1],
  fabric: ['Fabric026', 0.8],
};
for (const [name, [id, contrast]] of Object.entries(TEXTURES)) {
  const out = join(root, `apps/client/public/assets/textures/room_${name}.webp`);
  await sharp(join(from, id, `${id}_1K-JPG_Color.jpg`))
    .resize(512, 512)
    // The room's data says what colour cloth is: the texture only gives its weave.
    .grayscale(name === 'fabric')
    // Round a light grey, so the colour given in the room's data is what shows.
    .linear(contrast, 225 * (1 - contrast))
    .webp({ quality: 72 })
    .toFile(out);
  console.log(name, '←', id);
}
