import { generateCity, villaHomes } from '@fr33world/city';
import { HOMES, homePrice } from '@fr33world/shared';
import { describe, expect, it } from 'vitest';

const city = generateCity();

describe('homes (shared HOMES and the villas)', () => {
  it('the catalogue is the villas: same count, addresses and floor areas, in order', () => {
    const homes = villaHomes();
    expect(homes.length).toBe(HOMES.length);
    homes.forEach((h, i) => {
      expect(h.address).toBe(HOMES[i]?.[0]);
      expect(Math.round(h.villa.w * h.villa.d)).toBe(HOMES[i]?.[1]);
    });
    expect(new Set(HOMES.map((h) => h[0])).size).toBe(HOMES.length);
  });

  it('every home has a door point in front of its villa, outside the house', () => {
    const doors = city.points.filter((p) => p.kind === 'home');
    expect(doors.map((p) => p.home)).toEqual(HOMES.map((_, i) => i));
    for (const p of doors) {
      const v = villaHomes()[p.home as number]!.villa;
      expect(p.name).toBe(HOMES[p.home as number]?.[0]);
      // In front of the wall the drive leaves from, a couple of metres out.
      const gap = v.north ? v.z - v.d / 2 - p.z : p.z - (v.z + v.d / 2);
      expect(gap).toBeGreaterThan(1);
      expect(gap).toBeLessThan(4);
      expect(Math.abs(p.x - v.x)).toBeLessThan(0.01);
    }
  });

  it('prices run from about half a million to three quarters, in $5,000 steps', () => {
    const prices = HOMES.map((_, i) => homePrice(i) as number);
    for (const c of prices) expect(c % 500_000).toBe(0);
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(45_000_000);
    expect(Math.max(...prices)).toBeLessThanOrEqual(75_000_000);
    expect(homePrice(HOMES.length)).toBeNull();
  });
});
