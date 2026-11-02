/**
 * The heights a body may be at (server height checks): from just under the ground up to just
 * over the highest walkable surface there (a bridge deck over the river, the pier over the sea,
 * the freeway decks and their ramps).
 */
import type { CityLayout, Rect } from './layout.ts';
import { inside, PIER, QUARRY } from './plan.ts';
import { onDeck, rampHeightAt } from './ramps.ts';
import { terrainHeight } from './terrain.ts';

/** Sidewalk and deck top above the street (m). */
const DECK_TOP = 0.15;

export interface HeightRange {
  ground: number;
  top: number;
}

export function heightRange(city: CityLayout, x: number, z: number): HeightRange {
  const ground = terrainHeight(x, z);
  let top = ground;
  for (const b of city.bridges) {
    // The whole deck, out to its parapets.
    const onDeck = x >= b.x0 && x <= b.x1 && Math.abs(z - b.z) <= b.half + 1.5;
    if (onDeck) top = Math.max(top, DECK_TOP);
  }
  for (const p of PIER) if (inside(p, x, z)) top = Math.max(top, DECK_TOP);
  for (const fw of city.freeways) if (onDeck(fw, x, z, 1)) top = Math.max(top, fw.deckY);
  for (const r of city.ramps) {
    const y = rampHeightAt(r, x, z, 1);
    if (y !== null) top = Math.max(top, y);
  }
  return { ground, top };
}

/** Where a body on foot stands at (x, z): a bridge or the pier's deck, not a freeway above. */
export function walkHeight(city: CityLayout, x: number, z: number): number {
  const h = heightRange(city, x, z);
  return h.top <= DECK_TOP || h.top - h.ground < 4 ? h.top : h.ground;
}

/**
 * The paved top of a car park or forecourt: on the block's slab in the city, on the bare ground
 * at the quarry. A car standing in one of their bays stands here, not at street level.
 */
export function lotHeight(city: CityLayout, r: Rect): number {
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  return heightRange(city, cx, cz).top + (inside(QUARRY, cx, cz) ? 0 : DECK_TOP) + 0.02;
}
