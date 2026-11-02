import { CollisionIndex, generateCity, heightRange, type RampPoint } from '@fr33world/city';
import { describe, expect, it } from 'vitest';
import { MoveValidator, VEHICLE_LIMITS } from './validate.ts';

const city = generateCity();
const collision = CollisionIndex.fromCity(city);
const heights = (x: number, z: number) => heightRange(city, x, z);

/**
 * Drives a centreline at a steady 25 m/s, reporting every 50 ms like a client does, and
 * returns every verdict that wasn't 'ok' (with where it happened).
 */
function drive(points: readonly RampPoint[], offset = 0): string[] {
  const v = new MoveValidator(collision, city.bounds, heights);
  let now = 0;
  v.reset(now);
  const bad: string[] = [];
  let from: RampPoint | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as RampPoint;
    const b = points[i] as RampPoint;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    // Across the road by `offset` (left of the direction of travel).
    const ox = len ? (-(b.z - a.z) / len) * offset : 0;
    const oz = len ? ((b.x - a.x) / len) * offset : 0;
    from ??= { x: a.x + ox, y: a.y, z: a.z + oz };
    const steps = Math.max(1, Math.ceil(len / (25 * 0.05)));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const to = {
        x: a.x + (b.x - a.x) * t + ox,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t + oz,
      };
      now += 50;
      const verdict = v.check(from, to, VEHICLE_LIMITS, now);
      if (verdict !== 'ok') bad.push(`${verdict} at ${to.x.toFixed(0)},${to.z.toFixed(0)}`);
      else from = to;
    }
  }
  return bad;
}

describe('a car on the elevated roads', () => {
  it('drives up every ramp without the pillars beneath counting as walls', () => {
    for (const r of city.ramps) {
      for (const off of [-3, 0, 3]) expect(drive(r.points, off), r.name).toEqual([]);
    }
  });

  it('drives the length of every freeway deck, over its pillars', () => {
    for (const fw of city.freeways) {
      const at = (along: number) =>
        fw.axis === 'ew'
          ? { x: along, y: fw.deckY, z: fw.center }
          : { x: fw.center, y: fw.deckY, z: along };
      for (const off of [-9, -3, 3, 9]) {
        expect(drive([at(fw.from + 5), at(fw.to - 5)], off), fw.name).toEqual([]);
      }
    }
  });

  it('drives the hill roads, the quarry road up to the site office among them', () => {
    for (const r of city.hillRoads) expect(drive(r.points), r.name).toEqual([]);
  });

  it('lets reports held up by a mobile-data stall arrive all at once', () => {
    // A car at 45 m/s down a long east–west street; 2.5 s of reports land in the same instant.
    const road = city.roads.find((r) => r.axis === 'ew' && r.to - r.from > 600);
    if (!road) throw new Error('no long street');
    const v = new MoveValidator(collision, city.bounds, heights);
    v.reset(0);
    let now = 0;
    let from = { x: road.from + 50, y: 0, z: road.center + 2 };
    for (let i = 0; i < 20; i += 1) {
      now += 50;
      const to = { ...from, x: from.x + 2.25 };
      expect(v.check(from, to, VEHICLE_LIMITS, now)).toBe('ok');
      from = to;
    }
    now += 2500;
    for (let i = 0; i < 50; i += 1) {
      const to = { ...from, x: from.x + 2.25 };
      expect(v.check(from, to, VEHICLE_LIMITS, now), `report ${i}`).toBe('ok');
      from = to;
    }
  });

  it('still stops a car on the street from driving through a pillar', () => {
    const fw = city.freeways[0];
    const p = fw?.pillars[0];
    if (!fw || !p) throw new Error('no freeway pillar');
    const v = new MoveValidator(collision, city.bounds, heights);
    v.reset(0);
    const across = fw.axis === 'ew' ? { x: 0, z: 1 } : { x: 1, z: 0 };
    const from = { x: p.x - across.x * 3, y: 0, z: p.z - across.z * 3 };
    const to = { x: p.x + across.x * 3, y: 0, z: p.z + across.z * 3 };
    expect(v.check(from, to, VEHICLE_LIMITS, 300)).toBe('wall');
  });
});
