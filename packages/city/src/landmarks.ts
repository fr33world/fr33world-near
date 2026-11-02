/**
 * The plan's landmarks (docs/city-plan.md) as data shared by the server and the client: city
 * hall facing the spawn plaza, the observatory and the hillside sign in the hills, the pier's
 * Ferris wheel, and the stadium on its hill north of downtown. City hall and the observatory
 * are ordinary buildings (walls, windows and collision as any other); the rest add `solids`,
 * boxes nobody passes through.
 */
import type { Building, Rect } from './layout.ts';
import { inside, PIER } from './plan.ts';
import { hash2 } from './random.ts';
import { OBSERVATORY_AT, terrainHeight } from './terrain.ts';

/** A box a body can't pass through (the server tests it in plan, the client in 3D). */
export interface Solid {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
}

export interface SignLetter {
  char: string;
  /** Centre along the sign (x) and width; the ground under it (y). */
  x: number;
  w: number;
  y: number;
}

export interface Landmarks {
  /** City hall's tower: footprint centre, side and the height of its top (the cap sits on it). */
  cityHall: { x: number; z: number; side: number; top: number };
  /** The observatory: centre, the roof height the domes sit on, and the building's length. */
  observatory: { x: number; z: number; roof: number; length: number };
  /** The hillside sign, facing the city (+z): letters along x at depth z. */
  sign: { z: number; height: number; letters: SignLetter[] };
  /** The Ferris wheel on the pier: hub position, radius; the wheel turns in the y–z plane. */
  wheel: { x: number; z: number; hubY: number; radius: number };
  /**
   * The stadium: an oval bowl (centre, outer half-widths along x and z, the rim's height) on
   * its lot, with light towers round it.
   */
  stadium: {
    x: number;
    z: number;
    rx: number;
    rz: number;
    height: number;
    lot: Rect;
    towers: { x: number; z: number; height: number }[];
  };
}

/** City hall: on the block north of the plaza, across 7th St. */
const CITY_HALL_AT = { x: -60, z: -180 };
const SIGN_TEXT = 'LOS SOLES';
const SIGN_AT = { x: -380, z: -1290 };
const SIGN_HEIGHT = 26;

const SLAB_Y = 0.15;

export function isCityHallBlock(block: Rect): boolean {
  return inside(block, CITY_HALL_AT.x, CITY_HALL_AT.z);
}

/** City hall's podium and tower, centred in its block. */
export function placeCityHall(block: Rect, seed: number, out: Building[]): void {
  const x = (block.x0 + block.x1) / 2;
  const z = (block.z0 + block.z1) / 2;
  const push = (w: number, d: number, h: number, floorHeight: number) =>
    out.push({
      id: out.length,
      x,
      z,
      w,
      d,
      h,
      floorHeight,
      style: 'civic',
      seed: hash2(seed, 0xc17 + out.length),
    });
  push(Math.min(72, block.x1 - block.x0 - 12), Math.min(54, block.z1 - block.z0 - 12), 18, 4.5);
  push(26, 26, 104, 4.2);
}

export function placeObservatory(seed: number, out: Building[]): void {
  out.push({
    id: out.length,
    x: OBSERVATORY_AT.x,
    z: OBSERVATORY_AT.z,
    w: 64,
    d: 20,
    h: 10,
    floorHeight: 5,
    style: 'civic',
    seed: hash2(seed, 0x0b5),
    y: terrainHeight(OBSERVATORY_AT.x, OBSERVATORY_AT.z),
  });
}

/** The stadium's bowl: margin from its lot's edge, the oval's shape, the rim's height (m). */
const STADIUM_MARGIN = 12;
const STADIUM_ROUND = 0.88;
const STADIUM_HEIGHT = 26;
const TOWER_HEIGHT = 46;
/** Pieces of the outer wall's collision: short enough that each box hugs the curve. */
const STADIUM_PIECES = 72;

/** The stadium on its lot: the oval, closed all round, its wall a ring of short boxes. */
function makeStadium(lot: Rect, solids: Solid[]): Landmarks['stadium'] {
  const x = (lot.x0 + lot.x1) / 2;
  const z = (lot.z0 + lot.z1) / 2;
  const rx = (lot.x1 - lot.x0) / 2 - STADIUM_MARGIN;
  const rz = Math.min((lot.z1 - lot.z0) / 2 - STADIUM_MARGIN, rx * STADIUM_ROUND);
  const at = (i: number) => {
    const a = (i / STADIUM_PIECES) * Math.PI * 2;
    return [x + Math.cos(a) * rx, z + Math.sin(a) * rz] as const;
  };
  for (let i = 0; i < STADIUM_PIECES; i += 1) {
    const [ax, az] = at(i);
    const [bx, bz] = at(i + 1);
    solids.push({
      x0: Math.min(ax, bx) - 0.75,
      x1: Math.max(ax, bx) + 0.75,
      z0: Math.min(az, bz) - 0.75,
      z1: Math.max(az, bz) + 0.75,
      y0: 0,
      y1: STADIUM_HEIGHT,
    });
  }
  // Light towers on the diagonals, just outside the wall.
  const towers = [45, 135, 225, 315].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return {
      x: x + Math.cos(a) * (rx + 7),
      z: z + Math.sin(a) * (rz + 7),
      height: TOWER_HEIGHT,
    };
  });
  for (const t of towers) {
    solids.push({ x0: t.x - 1, x1: t.x + 1, z0: t.z - 1, z1: t.z + 1, y0: 0, y1: t.height });
  }
  return { x, z, rx, rz, height: STADIUM_HEIGHT, lot, towers };
}

/** The landmarks, and the solids they add (sign letters, the wheel's legs, the stadium). */
export function makeLandmarks(
  cityHallBlock: Rect,
  stadiumLot: Rect,
): { landmarks: Landmarks; solids: Solid[] } {
  const solids: Solid[] = [];

  // Sign letters: 18 m wide, 4.5 m apart, a wider gap for the space; centred on SIGN_AT (big
  // enough to read from downtown against the mountains).
  const letters: SignLetter[] = [];
  let at = 0;
  for (const char of SIGN_TEXT) {
    if (char === ' ') {
      at += 11;
      continue;
    }
    letters.push({ char, x: at + 9, w: 18, y: 0 });
    at += 22.5;
  }
  const span = at - 4.5;
  for (const l of letters) {
    l.x += SIGN_AT.x - span / 2;
    // Each letter stands where the slope is under it (the sign follows the hillside).
    l.y = terrainHeight(l.x, SIGN_AT.z);
    solids.push({
      x0: l.x - l.w / 2,
      x1: l.x + l.w / 2,
      z0: SIGN_AT.z - 1.5,
      z1: SIGN_AT.z + 0.5,
      y0: l.y - 2,
      y1: l.y + SIGN_HEIGHT + 3,
    });
  }

  // The wheel stands on the pier's platform; its legs splay along z.
  const platform = PIER[1] as Rect;
  const wheel = {
    x: (platform.x0 + platform.x1) / 2,
    z: (platform.z0 + platform.z1) / 2,
    hubY: SLAB_Y + 27,
    radius: 23,
  };
  for (const dx of [-2.5, 2.5]) {
    for (const dz of [-14, 14]) {
      const x = wheel.x + dx;
      const z = wheel.z + dz;
      solids.push({ x0: x - 1, x1: x + 1, z0: z - 1, z1: z + 1, y0: 0, y1: wheel.hubY });
    }
  }

  return {
    landmarks: {
      cityHall: {
        x: (cityHallBlock.x0 + cityHallBlock.x1) / 2,
        z: (cityHallBlock.z0 + cityHallBlock.z1) / 2,
        side: 26,
        top: SLAB_Y + 104,
      },
      observatory: {
        x: OBSERVATORY_AT.x,
        z: OBSERVATORY_AT.z,
        roof: terrainHeight(OBSERVATORY_AT.x, OBSERVATORY_AT.z) + SLAB_Y + 10,
        length: 64,
      },
      sign: { z: SIGN_AT.z, height: SIGN_HEIGHT, letters },
      wheel,
      stadium: makeStadium(stadiumLot, solids),
    },
    solids,
  };
}
