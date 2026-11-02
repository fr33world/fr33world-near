import {
  barrierGaps,
  generateCity,
  heightRange,
  type RampPoint,
  rampHeightAt,
} from '@fr33world/city';
import { beforeAll, describe, expect, it } from 'vitest';
import { Physics } from './physics.ts';

const city = generateCity();
let physics: Physics;

beforeAll(async () => {
  physics = await Physics.create(city);
  // Building the whole city's physics: seconds, more with every test file running at once.
}, 60_000);

/** The first surface straight down from `from` metres up at (x, z). */
function surfaceAt(x: number, z: number, from: number): number | null {
  const { rapier, world } = physics;
  physics.focus(x, z);
  const hit = world.castRay(new rapier.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), 200, true);
  return hit ? from - hit.timeOfImpact : null;
}

/** A point a fraction of the way along a ramp's centreline. */
function along(points: RampPoint[], f: number): RampPoint {
  const i = Math.min(points.length - 2, Math.floor(f * (points.length - 1)));
  const a = points[i] as RampPoint;
  const b = points[i + 1] as RampPoint;
  const t = f * (points.length - 1) - i;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

describe('the interchange and the freeway ramps', () => {
  const sol = city.freeways.find((f) => f.name === 'Sol Freeway');
  const valley = city.freeways.find((f) => f.name === 'Valley Freeway');

  it('connects the two decks in all four quadrants', () => {
    if (!sol || !valley) throw new Error('no freeways');
    const connectors = city.ramps.filter((r) => r.kind === 'connector');
    expect(connectors).toHaveLength(4);
    for (const c of connectors) {
      const ys = [c.points[0]?.y, c.points[c.points.length - 1]?.y].sort();
      expect(ys).toEqual([sol.deckY, valley.deckY]);
    }
  });

  it('brings both decks down to a junction at each end, where a parkway carries on', () => {
    if (!sol || !valley) throw new Error('no freeways');
    const descents = city.ramps.filter((r) => r.kind === 'descent');
    expect(descents).toHaveLength(4);
    for (const fw of [sol, valley]) {
      // Up only round the interchange, not to the city's ends.
      expect(fw.to - fw.from).toBeLessThan(400);
      const mine = descents.filter((d) => d.name.startsWith(fw.name));
      expect(mine).toHaveLength(2);
      for (const d of mine) {
        const top = d.points[0] as RampPoint;
        const foot = d.points[d.points.length - 1] as RampPoint;
        expect(top.y).toBe(fw.deckY);
        expect(foot.y).toBe(0);
        // Gentle enough to drive: no stretch steeper than 8 %.
        for (let i = 1; i < d.points.length; i += 1) {
          const a = d.points[i - 1] as RampPoint;
          const b = d.points[i] as RampPoint;
          expect(Math.abs(b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(0.08);
        }
        // The foot is at a junction, and the parkway goes on from the far side of it.
        const along = fw.axis === 'ew' ? foot.x : foot.z;
        const cross = city.roads.find(
          (r) =>
            r.axis !== fw.axis &&
            Math.abs(Math.abs(along - r.center) - (r.lanesPerDir * r.laneWidth + r.median / 2)) <
              0.01,
        );
        expect(cross).toBeDefined();
        const parkway = city.roads.find(
          (r) =>
            r.axis === fw.axis &&
            r.center === fw.center &&
            (r.to === cross?.center || r.from === cross?.center),
        );
        expect(parkway?.name).toMatch(/Parkway/);
      }
    }
  });

  it('cuts streets the descents pass over too low, and leaves room under the rest', () => {
    for (const d of city.ramps.filter((r) => r.kind === 'descent')) {
      for (const r of city.roads) {
        const p = d.points[0] as RampPoint;
        const ew = p.z === (d.points[1] as RampPoint).z;
        if (r.axis === (ew ? 'ew' : 'ns')) continue;
        const across = ew ? p.z : p.x;
        if (across < r.from || across > r.to) continue;
        // Streets between its top and its foot (it lands at the edge of the next one).
        const q = d.points[d.points.length - 1] as RampPoint;
        const [a0, a1] = ew ? [p.x, q.x] : [p.z, q.z];
        if (r.center <= Math.min(a0, a1) || r.center >= Math.max(a0, a1)) continue;
        const y = ew ? rampHeightAt(d, r.center, across) : rampHeightAt(d, across, r.center);
        if (y !== null) expect(y - d.depth).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('builds nothing under a ramp and lets the server accept bodies on them', () => {
    for (const r of city.ramps) {
      for (const b of city.buildings) {
        expect(rampHeightAt(r, b.x, b.z)).toBeNull();
      }
      const mid = along(r.points, 0.5);
      // Covers the ramp (a little generous on curves: the nearest segments within a metre).
      const { top } = heightRange(city, mid.x, mid.z);
      expect(top).toBeGreaterThanOrEqual(mid.y - 0.1);
      expect(top).toBeLessThan(mid.y + 1);
    }
  });

  it('gives the physics the ramps, deck barriers, and gaps where the ramps join', () => {
    if (!sol) throw new Error('no Sol Freeway');
    for (const r of city.ramps) {
      for (const f of [0.3, 0.6]) {
        const p = along(r.points, f);
        // In a lane, off a descent's centre barrier (descents run straight along x or z).
        const ew = r.points[0]?.z === r.points[1]?.z;
        const [x, z] = r.kind === 'descent' ? (ew ? [p.x, p.z + 5] : [p.x + 5, p.z]) : [p.x, p.z];
        expect(surfaceAt(x, z, p.y + 3)).toBeCloseTo(p.y, 0);
      }
    }
    // The barrier along the Sol deck's south edge: solid away from ramps, open at a gap.
    const edge = sol.center + sol.width / 2 - 0.3;
    const gap = barrierGaps(sol, city.ramps).find(([side]) => side === 1);
    if (!gap) throw new Error('no gap on the south edge');
    const open = (gap[1] + gap[2]) / 2;
    expect(surfaceAt(open, edge, sol.deckY + 3)).toBeCloseTo(sol.deckY, 1);
    expect(surfaceAt(640, edge, sol.deckY + 3)).toBeCloseTo(sol.deckY + 0.85, 1);
  });
});
