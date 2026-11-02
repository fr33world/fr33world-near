import { describe, expect, it } from 'vitest';
import {
  BAGS,
  decodeGear,
  encodeGear,
  EYEWEAR,
  HEADWEAR,
  isGear,
  NO_GEAR,
  type Gear,
} from './gear.ts';

describe('gear', () => {
  it('round-trips every field', () => {
    const g: Gear = {
      head: HEADWEAR.length - 1,
      eyes: EYEWEAR.length - 1,
      neck: 2,
      wrist: 3,
      bag: BAGS.length - 1,
      headColour: 6,
      bagColour: 4,
    };
    expect(decodeGear(encodeGear(g))).toEqual(g);
    expect(encodeGear(NO_GEAR)).toBe(0);
    expect(encodeGear(g)).toBeLessThan(2 ** 17);
  });

  it('rejects anything out of range, and decodes it as nothing worn', () => {
    expect(isGear({ ...NO_GEAR, head: HEADWEAR.length })).toBe(false);
    expect(isGear({ ...NO_GEAR, eyes: 1.5 })).toBe(false);
    expect(isGear({ ...NO_GEAR, bagColour: -1 })).toBe(false);
    expect(isGear(null)).toBe(false);
    // head 7 is past the list.
    expect(decodeGear(7)).toEqual(NO_GEAR);
  });
});
