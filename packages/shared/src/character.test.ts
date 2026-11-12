import { describe, expect, it } from 'vitest';
import {
  type Appearance,
  BUILDS,
  checkCharacterName,
  CLOTHES_COLOURS,
  decodeAppearance,
  DEFAULT_APPEARANCE,
  encodeAppearance,
  FACIAL_HAIR,
  handleFor,
  HEIGHTS,
  isAppearance,
  randomCharacterName,
  ROCKETBOX_FACES,
  ROCKETBOX_OUTFITS,
  SKIN_TONES,
} from './character.ts';

describe('character', () => {
  it('round-trips every value of every field through its 32-bit code', () => {
    for (const body of ['male', 'female'] as const) {
      const sizes: [keyof Appearance, number][] = [
        ['face', ROCKETBOX_FACES[body].length],
        ['outfit', ROCKETBOX_OUTFITS[body].length],
        ['skin', SKIN_TONES.length + 1],
        ['facialHair', body === 'male' ? FACIAL_HAIR.length : 1],
        ['top', CLOTHES_COLOURS.length + 1],
        ['bottom', CLOTHES_COLOURS.length + 1],
        ['shoes', CLOTHES_COLOURS.length + 1],
        ['height', HEIGHTS.length],
        ['build', BUILDS.length],
      ];
      for (const [key, n] of sizes) {
        for (let v = 0; v < n; v += 1) {
          const a = { ...DEFAULT_APPEARANCE, body, [key]: v };
          expect(isAppearance(a)).toBe(true);
          expect(decodeAppearance(encodeAppearance(a))).toEqual(a);
        }
      }
      // Everything at its largest at once.
      const max = Object.fromEntries(sizes.map(([k, n]) => [k, n - 1]));
      const a = { ...DEFAULT_APPEARANCE, body, ...max };
      expect(decodeAppearance(encodeAppearance(a))).toEqual(a);
      expect(encodeAppearance(a)).toBeLessThan(2 ** 31);
    }
  });

  it('rejects malformed appearances and decodes nonsense to the defaults', () => {
    expect(isAppearance({ ...DEFAULT_APPEARANCE, skin: 7 })).toBe(false);
    expect(isAppearance({ ...DEFAULT_APPEARANCE, face: 1.5 })).toBe(false);
    expect(isAppearance({ ...DEFAULT_APPEARANCE, body: 'robot' })).toBe(false);
    // Women have no facial hair; the female lists are shorter.
    expect(isAppearance({ ...DEFAULT_APPEARANCE, body: 'female', facialHair: 1 })).toBe(false);
    expect(isAppearance({ ...DEFAULT_APPEARANCE, body: 'female', face: 17 })).toBe(false);
    expect(isAppearance(null)).toBe(false);
    expect(decodeAppearance(0xffffffff)).toEqual({ ...DEFAULT_APPEARANCE, body: 'female' });
  });

  it('checks role-play names: first and last, letters, tidied capitals', () => {
    expect(checkCharacterName('  ada   lovelace ')).toEqual({ name: 'Ada Lovelace' });
    expect(checkCharacterName('JOHN SMITH')).toEqual({ name: 'John Smith' });
    expect(checkCharacterName("shay o'neil")).toEqual({ name: "Shay O'neil" });
    expect(checkCharacterName('Ronan McDonald')).toEqual({ name: 'Ronan McDonald' });
    expect(checkCharacterName('Mary-Jane Watson')).toEqual({ name: 'Mary-Jane Watson' });
    for (const bad of [
      'Ada',
      'Ada B',
      'A Lovelace',
      'Ada Love Lace',
      'Ad4 Lovelace',
      'Ada -Lovelace',
      '',
      7,
    ])
      expect(checkCharacterName(bad)).toHaveProperty('error');
  });
});

describe('names nobody typed', () => {
  it('make a game handle, the same for the same login, never from an email', () => {
    const a = handleFor('did:privy:cm1abc');
    expect(a).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
    expect(handleFor('did:privy:cm1abc')).toBe(a);
    expect(handleFor('did:privy:cm1abd')).not.toBe(a);
    const many = new Set(Array.from({ length: 200 }, (_, i) => handleFor(`did:privy:${i}`)));
    expect(many.size).toBeGreaterThan(190);
    for (const h of many) expect(h.length).toBeLessThanOrEqual(24);
  });

  it('offer real-sounding character names the rules accept', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 300; i += 1) {
      const name = randomCharacterName(i % 2 ? 'female' : 'male', rand);
      expect(checkCharacterName(name)).toEqual({ name });
    }
  });
});
