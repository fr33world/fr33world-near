/**
 * Storefronts (the commercial art pass): every shop gets a sign board with an original name
 * and a fabric awning over its street side; signs glow at night. On Estrella Boulevard, the
 * nightlife strip (city plan: "The Boulevard"), the signs are neon instead: glowing tube
 * lettering on a dark backing, a tube round each sign and along each awning's edge, dull by
 * day and bright at night. The sign names are painted
 * into one canvas atlas at start-up (nothing to download), so all the city's signs are one
 * draw call, and the awnings another. Names are invented for Los Soles (no real brands).
 */
import { type Building, type CityLayout, type Rect, rng } from '@fr33world/city';
import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';
import { TiledGeo } from './tiles.ts';

const SLAB_Y = 0.15;

const SHOPS = [
  'CASA TACOS',
  'ESTRELLA LIQUOR',
  'PALMAS MARKET',
  'GOLDEN COAST DONUTS',
  'SUDS LAUNDRY',
  'PACIFIC DENTAL',
  'VISTA NAILS',
  'BOULEVARD BARBER',
  'MESA PHARMACY',
  'CANYON BURGERS',
  'OCEAN PHO',
  'CRESCENT BOOKS',
  'ARROYO TIRES',
  'BONITA BAKERY',
  "ROSA'S FLOWERS",
  'MISSION PHONE REPAIR',
  'GRANADA GRILL',
  'REDWOOD GYM',
  'LAUREL CLEANERS',
  'CYPRESS COFFEE',
  'HARBOR FISH',
  'ORCHARD JUICE',
  'FAIRVIEW TAX',
  'OLIVE THAI',
  'SIERRA SHOES',
  'CAMINO AUTO',
  'SUNNY NOODLES',
  'DOS AMIGOS',
  'LUCKY 7 MART',
  'PALM SURF',
  'STAR VIDEO',
  'NOPAL CAFE',
];
/** Sign colours: [background, lettering]. */
const SIGN_STYLES: [string, string][] = [
  ['#c62f2f', '#fff6e0'],
  ['#1f4f8f', '#ffffff'],
  ['#f2c14e', '#1d1d1d'],
  ['#2f7d4f', '#f7f3e3'],
  ['#1d1d1d', '#ffd166'],
  ['#f7f3e3', '#b23a48'],
  ['#6a3d9a', '#ffffff'],
  ['#0f7c8c', '#fff9e8'],
];
const AWNING_COLOURS = [0xb3323a, 0x1f4f8f, 0x2f7d4f, 0xd9a623, 0x6a3d9a, 0x0f7c8c, 0x7a4a2a];

const COLS = 4;
const ROWS = 8;
const CELL_W = 512;
const CELL_H = 128;

/** Neon colours: pink, cyan, violet, lime, amber, red. */
const NEON = ['#ff3fb4', '#33e6ff', '#b16bff', '#9dff3a', '#ffb02e', '#ff4b4b'];

/** The neon atlas: the same names as glowing tubes on black, in the cell's colour. */
function neonAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL_W;
  canvas.height = ROWS * CELL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.fillStyle = '#07060a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  SHOPS.forEach((name, i) => {
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    const tube = NEON[i % NEON.length] as string;
    let size = 60;
    const font = (px: number) => `600 ${px}px 'Bebas Neue', 'Arial Narrow', system-ui, sans-serif`;
    ctx.font = font(size);
    while (ctx.measureText(name).width > CELL_W - 70 && size > 24) ctx.font = font((size -= 4));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // The glow, then the tube, then its hot white core.
    ctx.shadowColor = tube;
    ctx.shadowBlur = 22;
    ctx.strokeStyle = tube;
    ctx.lineWidth = 7;
    ctx.strokeText(name, x + CELL_W / 2, y + CELL_H / 2 + 4);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(name, x + CELL_W / 2, y + CELL_H / 2 + 4);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** One canvas holding every shop sign (COLS × ROWS cells). */
function signAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL_W;
  canvas.height = ROWS * CELL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  SHOPS.forEach((name, i) => {
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    const [bg, fg] = SIGN_STYLES[i % SIGN_STYLES.length] as [string, string];
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 6;
    ctx.strokeRect(x + 8, y + 8, CELL_W - 16, CELL_H - 16);
    ctx.fillStyle = fg;
    let size = 64;
    ctx.font = `900 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    while (ctx.measureText(name).width > CELL_W - 60 && size > 24) {
      size -= 4;
      ctx.font = `900 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, x + CELL_W / 2, y + CELL_H / 2 + 4);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The shop's front: the wall nearest an edge of its block (shops on a boulevard face the
 * boulevard, those in a row face their street). Returns the wall's centre, the outward
 * normal and the direction along the wall that reads left to right from the street.
 */
function frontWall(b: Building, blocks: Rect[]) {
  const block = blocks.find((r) => b.x >= r.x0 && b.x <= r.x1 && b.z >= r.z0 && b.z <= r.z1);
  if (!block) return null;
  const sides = [
    { gap: b.z - b.d / 2 - block.z0, n: [0, -1], centre: [b.x, b.z - b.d / 2], len: b.w },
    { gap: block.z1 - (b.z + b.d / 2), n: [0, 1], centre: [b.x, b.z + b.d / 2], len: b.w },
    { gap: b.x - b.w / 2 - block.x0, n: [-1, 0], centre: [b.x - b.w / 2, b.z], len: b.d },
    { gap: block.x1 - (b.x + b.w / 2), n: [1, 0], centre: [b.x + b.w / 2, b.z], len: b.d },
  ].sort((p, q) => p.gap - q.gap);
  const s = sides[0] as (typeof sides)[number];
  const [nx, nz] = s.n as [number, number];
  // Facing the wall from outside you look along -normal; your right is (-normal) × up.
  const right = new THREE.Vector3(nz, 0, -nx);
  const [cx, cz] = s.centre as [number, number];
  return {
    centre: new THREE.Vector3(cx, 0, cz),
    normal: new THREE.Vector3(nx, 0, nz),
    right,
    length: s.len,
  };
}

export interface Storefronts {
  group: THREE.Group;
  /** Signs light up as night falls (0 day … 1 night). */
  update(night: number): void;
}

/** Tiles of signs and awnings (tiles.ts), drawn within `maxDistance`. */
export function buildStorefronts(city: CityLayout, maxDistance: number): Storefronts {
  const shops = city.buildings.filter((b) => b.style === 'stucco_shop' && b.w >= 9);
  const tiles = new TiledGeo(() => ({
    signs: new GeoBuilder(),
    neon: new GeoBuilder(),
    tubes: new GeoBuilder().attribute('color', 3, [1, 1, 1]),
    awnings: new GeoBuilder().attribute('color', 3, [1, 1, 1]),
  }));
  const colour = new THREE.Color();
  // The Boulevard: shops whose front is on Estrella Boulevard's sidewalk.
  const strip = city.roads.filter((r) => r.name === 'Estrella Boulevard' && r.axis === 'ew');
  const onStrip = (p: THREE.Vector3) =>
    strip.some((r) => p.x > r.from && p.x < r.to && Math.abs(p.z - r.center) < 30);

  for (const b of shops) {
    const front = frontWall(b, city.blocks);
    if (!front) continue;
    const { signs, neon, tubes, awnings } = tiles.at(b.x, b.z);
    const lit = onStrip(front.centre);
    const r = rng(b.seed ^ 0x5409);
    const { centre, normal, right } = front;
    /** A point on the front: `s` along the wall (to the reader's right), height `y`, `o` out. */
    const at = (s: number, y: number, o: number) =>
      centre.clone().addScaledVector(right, s).addScaledVector(normal, o).setY(y);
    const width = Math.min(front.length - 1.5, 9);
    const h = width / 2;

    // Awning: slopes out and down from above the shop window, with a front valance.
    const top = SLAB_Y + 3.3;
    const lip = SLAB_Y + 2.75;
    const reach = 1.5;
    awnings.set('color', colour.setHex(r.pick(AWNING_COLOURS)).toArray());
    const slopeNormal = normal
      .clone()
      .multiplyScalar(top - lip)
      .setY(reach)
      .normalize();
    awnings.quad(
      at(-h, top, 0.05),
      at(h, top, 0.05),
      at(h, lip, reach),
      at(-h, lip, reach),
      slopeNormal,
      [0, 0, 1, 0, 1, 1, 0, 1],
    );
    awnings.quad(
      at(-h, lip - 0.3, reach),
      at(h, lip - 0.3, reach),
      at(h, lip, reach),
      at(-h, lip, reach),
      normal,
      [0, 0, 1, 0, 1, 1, 0, 1],
    );

    // Sign board above the awning, its face from the atlas, reading left to right.
    const i = r.int(0, SHOPS.length - 1);
    const u0 = (i % COLS) / COLS;
    const u1 = u0 + 1 / COLS;
    const v1 = 1 - Math.floor(i / COLS) / ROWS;
    const v0 = v1 - 1 / ROWS;
    const signW = Math.min(width, 7.5);
    const sy0 = top + 0.3;
    const sy1 = Math.min(sy0 + signW / 4, SLAB_Y + b.h - 0.3);
    const sw = signW / 2;
    if (lit) {
      // Neon: the tube lettering, a tube round the sign and along the awning's lip.
      neon.quad(
        at(-sw, sy0, 0.08),
        at(sw, sy0, 0.08),
        at(sw, sy1, 0.08),
        at(-sw, sy1, 0.08),
        normal,
        [u0, v0, u1, v0, u1, v1, u0, v1],
      );
      tubes.set('color', colour.set(NEON[i % NEON.length] as string).toArray());
      const t = 0.09;
      const bar = (s0: number, y0: number, s1: number, y1: number, o: number) =>
        tubes.quad(
          at(s0, y0, o),
          at(s1, y0, o),
          at(s1, y1, o),
          at(s0, y1, o),
          normal,
          [0, 0, 1, 0, 1, 1, 0, 1],
        );
      bar(-sw - t, sy0 - t, sw + t, sy0, 0.1);
      bar(-sw - t, sy1, sw + t, sy1 + t, 0.1);
      bar(-sw - t, sy0, -sw, sy1, 0.1);
      bar(sw, sy0, sw + t, sy1, 0.1);
      tubes.set('color', colour.set(NEON[(i + 2) % NEON.length] as string).toArray());
      bar(-h, lip - 0.3, h, lip - 0.3 + t, reach + 0.02);
      continue;
    }
    signs.quad(
      at(-sw, sy0, 0.08),
      at(sw, sy0, 0.08),
      at(sw, sy1, 0.08),
      at(-sw, sy1, 0.08),
      normal,
      [u0, v0, u1, v0, u1, v1, u0, v1],
    );
  }

  const atlas = signAtlas();
  const signMaterial = new THREE.MeshStandardMaterial({
    map: atlas,
    emissiveMap: atlas,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.55,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const neonMaterial = new THREE.MeshStandardMaterial({
    map: neonAtlas(),
    emissive: 0xffffff,
    emissiveIntensity: 0.2,
    roughness: 0.4,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  neonMaterial.emissiveMap = neonMaterial.map;
  // Tubes: their own colour, dim by day and full at night (not lit by the scene).
  const tubeMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x555555 });
  const awningMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const group = tiles.build(
    {
      signs: { material: signMaterial, name: 'shop-signs' },
      neon: { material: neonMaterial, name: 'neon-signs' },
      tubes: { material: tubeMaterial, name: 'neon-tubes' },
      awnings: { material: awningMaterial, name: 'awnings', cast: true },
    },
    maxDistance,
    'storefronts',
  );
  return {
    group,
    update(night: number) {
      signMaterial.emissiveIntensity = night * 0.9;
      neonMaterial.emissiveIntensity = 0.25 + night * 2.2;
      tubeMaterial.color.setScalar(0.35 + night * 0.65);
    },
  };
}
