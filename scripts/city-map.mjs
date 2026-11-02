#!/usr/bin/env node
/**
 * Draws the generated city from above (roads, blocks, buildings by style, freeways, hill
 * roads, coast, river) to an SVG, to check the generator against the approved plan.
 *   node scripts/city-map.mjs [out.svg]   (default docs/city-greybox.svg)
 */
import { writeFileSync } from 'node:fs';
import {
  carriageHalfWidth,
  generateCity,
  HARBOUR,
  HILL_HALF,
  landOutline,
  PIER,
  RIVER,
  WORLD,
} from '../packages/city/src/index.ts';

const out = process.argv[2] ?? new URL('../docs/city-greybox.svg', import.meta.url).pathname;
const city = generateCity();
const S = 0.25; // px per metre
const X = (x) => ((x - WORLD.x0) * S).toFixed(1);
const Z = (z) => ((z - WORLD.z0) * S).toFixed(1);
const L = (v) => (v * S).toFixed(1);
const size = (WORLD.x1 - WORLD.x0) * S;
const COLOURS = {
  glass_tower: '#5d7ea8',
  deco: '#8d86a6',
  office_midrise: '#9aa3ad',
  stucco_shop: '#e0b98a',
  brick_loft: '#b5654a',
  warehouse: '#8f8a7e',
  house: '#e8d3a8',
  villa: '#f2e6c8',
  civic: '#f4f0e6',
};
const parts = [];
parts.push(`<rect width="${size}" height="${size}" fill="#6fa8c9"/>`);
parts.push(
  `<polygon points="${landOutline()
    .map(([x, z]) => `${X(x)},${Z(z)}`)
    .join(' ')}" fill="#d9d2c3"/>`,
);
for (const p of PIER) {
  parts.push(
    `<rect x="${X(p.x0)}" y="${Z(p.z0)}" width="${L(p.x1 - p.x0)}" height="${L(p.z1 - p.z0)}" fill="#8a6f55"/>`,
  );
}
parts.push(
  `<rect x="${X(HARBOUR.x0)}" y="${Z(HARBOUR.z0)}" width="${L(HARBOUR.x1 - HARBOUR.x0)}" height="${L(HARBOUR.z1 - HARBOUR.z0)}" fill="#6fa8c9"/>`,
);
parts.push(
  `<rect x="${X(RIVER.x0)}" y="${Z(RIVER.z0)}" width="${L(RIVER.x1 - RIVER.x0)}" height="${L(RIVER.z1 - RIVER.z0)}" fill="#a9b4bd"/>`,
);
for (const b of city.blocks)
  parts.push(
    `<rect x="${X(b.x0)}" y="${Z(b.z0)}" width="${L(b.x1 - b.x0)}" height="${L(b.z1 - b.z0)}" fill="#c7c0b2"/>`,
  );
for (const r of city.roads) {
  const h = carriageHalfWidth(r);
  const [x, z, w, d] =
    r.axis === 'ns'
      ? [r.center - h, r.from, 2 * h, r.to - r.from]
      : [r.from, r.center - h, r.to - r.from, 2 * h];
  parts.push(
    `<rect x="${X(x)}" y="${Z(z)}" width="${L(w)}" height="${L(d)}" fill="${r.median ? '#ff9f43' : '#4a4a4a'}"/>`,
  );
}
for (const b of city.buildings)
  parts.push(
    `<rect x="${X(b.x - b.w / 2)}" y="${Z(b.z - b.d / 2)}" width="${L(b.w)}" height="${L(b.d)}" fill="${COLOURS[b.style]}"/>`,
  );
for (const p of city.palms)
  parts.push(`<circle cx="${X(p.x)}" cy="${Z(p.z)}" r="0.9" fill="#3d7a3a"/>`);
for (const f of city.freeways) {
  const [x, z, w, d] =
    f.axis === 'ew'
      ? [f.from, f.center - f.width / 2, f.to - f.from, f.width]
      : [f.center - f.width / 2, f.from, f.width, f.to - f.from];
  parts.push(
    `<rect x="${X(x)}" y="${Z(z)}" width="${L(w)}" height="${L(d)}" fill="#5b6b7a" fill-opacity="0.85"/>`,
  );
}
for (const r of city.hillRoads) {
  const pts = r.points.map((q) => `${X(q.x)},${Z(q.z)}`).join(' ');
  parts.push(
    `<polyline points="${pts}" fill="none" stroke="#4a4a4a" stroke-width="${L(2 * HILL_HALF)}"/>`,
  );
}
for (const r of city.ramps) {
  const pts = r.points.map((q) => `${X(q.x)},${Z(q.z)}`).join(' ');
  parts.push(
    `<polyline points="${pts}" fill="none" stroke="#5b6b7a" stroke-opacity="0.85" stroke-width="${L(r.width)}"/>`,
  );
}
const st = city.landmarks.stadium;
parts.push(
  `<ellipse cx="${X(st.x)}" cy="${Z(st.z)}" rx="${L(st.rx)}" ry="${L(st.rz)}" fill="#e6e2da" stroke="#2f5f9e" stroke-width="4"/>`,
);
const p = city.plaza;
parts.push(
  `<rect x="${X(p.x0)}" y="${Z(p.z0)}" width="${L(p.x1 - p.x0)}" height="${L(p.z1 - p.z0)}" fill="none" stroke="#7def06" stroke-width="2"/>`,
);
writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${parts.join('')}</svg>\n`,
);
console.log(
  `wrote ${out}: ${city.roads.length} road segments, ${city.blocks.length} blocks, ${city.buildings.length} buildings`,
);
