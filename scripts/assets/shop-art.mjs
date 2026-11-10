#!/usr/bin/env node
/**
 * The modals' pictures, rendered by Blender (scripts/blender/shop_art.py), trimmed and saved as
 * small WebP: public/ui/shop (goods), public/ui/medals (a medallion per place and faction) and
 * public/ui/usdc.webp. Shapes for the medallions come from @iconify-json/game-icons.
 *   node scripts/assets/shop-art.mjs [names...]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../..');
const blender = process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const ui = join(root, 'apps/client/public/ui');
const stage = process.env.STAGE ?? mkdtempSync(join(tmpdir(), 'shop-art-'));
const only = process.argv.slice(2);
mkdirSync(join(ui, 'shop'), { recursive: true });
mkdirSync(join(ui, 'medals'), { recursive: true });

const GOODS = [
  'pistol',
  'pistol_rounds',
  'rifle',
  'rifle_rounds',
  'licence',
  'water',
  'sandwich',
  'meal',
];
/** enamel, metal, the game-icons shape, and how much of the disc it fills. */
const MEDALS = {
  police: { icon: 'police-officer-head', enamel: '#123058', metal: '#d4a93e' },
  ems: { icon: 'caduceus', enamel: '#0c6c70', metal: '#dfe4ea' },
  vipers: { icon: 'snake-tongue', enamel: '#1e4a1c', metal: '#c8d2c0' },
  kings: { icon: 'crown', enamel: '#4a1d78', metal: '#e0b43e' },
  gun: { icon: 'pistol-gun', enamel: '#22262d', metal: '#d4a93e' },
  dealer: { icon: 'car-key', enamel: '#3c2a0e', metal: '#e0b43e' },
  pharmacy: { icon: 'heart-plus', enamel: '#0c6c70', metal: '#eef1f4' },
  shop: { icon: 'sun', enamel: '#b5560e', metal: '#ffd86b', half: 0.68 },
  parking: { icon: 'steering-wheel', enamel: '#123f8c', metal: '#e8edf5' },
  guide: { icon: 'compass', enamel: '#17492f', metal: '#dfe4ea' },
  settings: { icon: 'cog', enamel: '#22262d', metal: '#c9ced6' },
  desk: { icon: 'id-card', enamel: '#22262d', metal: '#c9ced6' },
  black: { icon: 'spy', enamel: '#17181c', metal: '#a8acb4' },
};

const icons = JSON.parse(
  readFileSync(join(root, 'node_modules/@iconify-json/game-icons/icons.json'), 'utf8'),
).icons;
for (const [name, m] of Object.entries(MEDALS)) {
  if (!icons[m.icon]) throw new Error(`no game-icon called ${m.icon}`);
  writeFileSync(
    join(stage, `icon-${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${icons[m.icon].body}</svg>`,
  );
}
writeFileSync(join(stage, 'medallions.json'), JSON.stringify(MEDALS));

// The real USDC mark (assets/brand/usdc.svg): only its white parts stand proud of the coin.
const usdc = readFileSync(join(root, 'assets/brand/usdc.svg'), 'utf8');
const white = [...usdc.matchAll(/<path[^>]*d="([^"]+)"[^>]*fill="#fff"[^>]*\/>/g)].map((p) => p[1]);
writeFileSync(
  join(stage, 'usdc-white.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000">${white.map((d) => `<path fill="#000" d="${d}"/>`).join('')}</svg>`,
);

// The licence's printed face, in the game's own fonts' spirit: everything here is invented.
const badge = icons['police-badge'].body.replace(/fill="currentColor"/g, 'fill="#c9a03a"');
const face = `<svg xmlns="http://www.w3.org/2000/svg" width="1368" height="864" viewBox="0 0 1368 864">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6f3ea"/><stop offset="1" stop-color="#ddd7c6"/></linearGradient></defs>
  <rect width="1368" height="864" fill="url(#g)"/>
  <rect width="1368" height="190" fill="#14294a"/>
  <text x="56" y="86" font-family="Helvetica Neue, Arial" font-weight="700" font-size="48" fill="#e4c36a" letter-spacing="4">CITY OF LOS SOLES</text>
  <text x="56" y="154" font-family="Helvetica Neue, Arial" font-weight="800" font-size="60" fill="#fff" letter-spacing="2">FIREARM LICENSE</text>
  <g transform="translate(1130 18) scale(0.3)">${badge}</g>
  <rect x="56" y="240" width="330" height="430" rx="14" fill="#cfd5de"/>
  <circle cx="221" cy="400" r="88" fill="#67707e"/><path d="M92 670c10-140 70-180 129-180s119 40 129 180z" fill="#67707e"/>
  <g font-family="Helvetica Neue, Arial" fill="#20283a">
    <text x="440" y="282" font-size="34" font-weight="700" fill="#7c8596">NAME</text><rect x="440" y="300" width="560" height="44" rx="6" fill="#2a3346"/>
    <text x="440" y="416" font-size="34" font-weight="700" fill="#7c8596">CLASS</text><text x="440" y="476" font-size="62" font-weight="800">A · HANDGUN</text>
    <text x="440" y="552" font-size="34" font-weight="700" fill="#7c8596">ISSUED BY</text><text x="440" y="610" font-size="52" font-weight="700">LOS SOLES POLICE</text>
  </g>
  <rect x="56" y="736" width="1256" height="74" fill="#14294a"/>
  ${Array.from({ length: 62 }, (_, i) => `<rect x="${72 + i * 20}" y="750" width="${4 + ((i * 7) % 11)}" height="46" fill="#e4c36a"/>`).join('')}
</svg>`;
await sharp(Buffer.from(face)).png().toFile(join(stage, 'licence-face.png'));

const run = spawnSync(
  blender,
  [
    '-b',
    '--factory-startup',
    '--python',
    join(root, 'scripts/blender/shop_art.py'),
    '--',
    stage,
    ...only,
  ],
  { encoding: 'utf8', maxBuffer: 1 << 28 },
);
if (run.status !== 0 || !/BUILT/.test(run.stdout)) {
  console.error(`${run.stdout}${run.stderr}`.split('\n').slice(-30).join('\n'));
  process.exit(1);
}
const want = (n) => only.length === 0 || only.includes(n);
const shrink = (from, to, size) =>
  sharp(join(stage, `${from}.png`))
    .trim({ threshold: 2 })
    .resize({
      width: size,
      height: size,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 86, alphaQuality: 92 })
    .toFile(to);
for (const g of GOODS) if (want(g)) await shrink(g, join(ui, 'shop', `${g}.webp`), 360);
for (const m of Object.keys(MEDALS))
  if (want(m)) await shrink(`m-${m}`, join(ui, 'medals', `${m}.webp`), 240);
if (want('usdc')) await shrink('usdc', join(ui, 'usdc.webp'), 320);
if (process.env.STAGE) console.log('kept', stage);
else rmSync(stage, { recursive: true, force: true });
