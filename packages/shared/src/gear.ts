/**
 * What a character wears besides their outfit (Phase 3, owner 2026-10-29): a hat, eyewear, a
 * chain, a watch and a bag, with colours for the hat and the bag. Its own number beside the
 * appearance (which fills 31 bits), stored with the character, carried in the world ticket
 * and the enter message; the client draws the items on the skeleton (accessories.ts).
 */
import { CLOTHES_COLOURS } from './character.ts';

export const HEADWEAR = ['none', 'cap', 'cap_back', 'beanie', 'bucket'] as const;
export const EYEWEAR = ['none', 'shades', 'glasses', 'aviators'] as const;
export const NECKWEAR = ['none', 'gold_chain', 'silver_chain', 'cuban'] as const;
export const WRISTWEAR = ['none', 'gold_watch', 'silver_watch', 'black_watch'] as const;
export const BAGS = ['none', 'backpack', 'sling'] as const;

export interface Gear {
  /** Index into HEADWEAR, EYEWEAR, NECKWEAR, WRISTWEAR, BAGS. */
  head: number;
  eyes: number;
  neck: number;
  wrist: number;
  bag: number;
  /** Index into CLOTHES_COLOURS. */
  headColour: number;
  bagColour: number;
}

export const NO_GEAR: Gear = {
  head: 0,
  eyes: 0,
  neck: 0,
  wrist: 0,
  bag: 0,
  headColour: 0,
  bagColour: 0,
};

const LIMITS: Record<keyof Gear, number> = {
  head: HEADWEAR.length,
  eyes: EYEWEAR.length,
  neck: NECKWEAR.length,
  wrist: WRISTWEAR.length,
  bag: BAGS.length,
  headColour: CLOTHES_COLOURS.length,
  bagColour: CLOTHES_COLOURS.length,
};

/** Well-formed gear (from a client: every field checked). */
export function isGear(v: unknown): v is Gear {
  if (typeof v !== 'object' || v === null) return false;
  const g = v as Record<string, unknown>;
  return (Object.keys(LIMITS) as (keyof Gear)[]).every((k) => {
    const n = g[k];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < LIMITS[k];
  });
}

/** Bit fields, low to high: [field, width]. 17 bits in all. */
const FIELDS: [keyof Gear, number][] = [
  ['head', 3],
  ['eyes', 2],
  ['neck', 2],
  ['wrist', 2],
  ['bag', 2],
  ['headColour', 3],
  ['bagColour', 3],
];

export function encodeGear(g: Gear): number {
  let code = 0;
  let shift = 0;
  for (const [key, bits] of FIELDS) {
    code |= (g[key] & ((1 << bits) - 1)) << shift;
    shift += bits;
  }
  return code >>> 0;
}

/** The gear in `code`; anything out of range wears nothing. */
export function decodeGear(code: number): Gear {
  const g = { ...NO_GEAR };
  let shift = 0;
  for (const [key, bits] of FIELDS) {
    g[key] = (code >>> shift) & ((1 << bits) - 1);
    shift += bits;
  }
  return isGear(g) ? g : { ...NO_GEAR };
}
