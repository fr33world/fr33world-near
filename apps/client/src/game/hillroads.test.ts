import {
  generateCity,
  heightRange,
  HILL_GRADE,
  HILL_HALF,
  type HillRoad,
  naturalHeight,
  OBSERVATORY_AT,
  type RampPoint,
  terrainHeight,
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

const road = (name: string): HillRoad => {
  const r = city.hillRoads.find((h) => h.name === name);
  if (!r) throw new Error(`no ${name}`);
  return r;
};

/** Each segment's middle, with the unit vector across the road (to the right of travel). */
function middles(r: HillRoad) {
  return r.points.slice(1).map((b, i) => {
    const a = r.points[i] as RampPoint;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      z: (a.z + b.z) / 2,
      across: [-(b.z - a.z) / len, (b.x - a.x) / len] as const,
    };
  });
}

describe('hill roads', () => {
  it('climb from the ends of city streets into the hills, and up to the observatory', () => {
    expect(city.hillRoads.length).toBeGreaterThanOrEqual(5);
    for (const r of city.hillRoads) {
      const start = r.points[0] as RampPoint;
      if (r.leaves) {
        expect(city.hillRoads.some((o) => o.name === r.leaves)).toBe(true);
      } else {
        // Carries on from a street that ends at the hills' edge, level with it.
        const street = city.roads.find(
          (s) => s.axis === 'ns' && s.center === start.x && s.from === start.z,
        );
        expect(street, r.name).toBeDefined();
        expect(start.y).toBe(0);
      }
      expect(Math.min(...r.points.map((p) => p.z))).toBeLessThan(-950);
    }
    const end = road('Observatory Road').points.at(-1) as RampPoint;
    expect(Math.hypot(end.x - OBSERVATORY_AT.x, end.z - OBSERVATORY_AT.z)).toBeLessThan(80);
    expect(end.y).toBeGreaterThan(50);
  });

  it('hold a drivable grade and curves a car can take', () => {
    for (const r of city.hillRoads) {
      const pts = r.points;
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1] as RampPoint;
        const b = pts[i] as RampPoint;
        expect(Math.abs(b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(
          HILL_GRADE + 1e-6,
        );
      }
      // Radius through every third point: hairpins included, nothing tighter than 7 m.
      for (let i = 2; i < pts.length - 2; i += 1) {
        const [a, b, c] = [pts[i - 2], pts[i], pts[i + 2]] as RampPoint[] as [
          RampPoint,
          RampPoint,
          RampPoint,
        ];
        const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
        if (cross < 1e-6) continue;
        const r3 =
          (Math.hypot(b.x - a.x, b.z - a.z) *
            Math.hypot(c.x - b.x, c.z - b.z) *
            Math.hypot(a.x - c.x, a.z - c.z)) /
          (2 * cross);
        expect(r3, `${r.name} at ${i}`).toBeGreaterThan(7);
      }
    }
  });

  it('are graded into the terrain: level across the road, banks without steps', () => {
    for (const r of city.hillRoads) {
      const others = city.hillRoads.filter((o) => o !== r);
      for (const m of middles(r).filter((_, i) => i % 10 === 0)) {
        // Level across the road (except where it meets another: the junction blends them).
        const junction = others.some((o) =>
          o.points.some((p) => Math.hypot(p.x - m.x, p.z - m.z) < 4 * HILL_HALF + 8),
        );
        for (const c of junction ? [] : [-HILL_HALF, 0, HILL_HALF]) {
          const h = terrainHeight(m.x + m.across[0] * c, m.z + m.across[1] * c);
          expect(h).toBeCloseTo(m.y, 1);
        }
        // Out across the bank on both sides, every 10 cm: the cut or fill changes smoothly
        // (a step, where two stretches of road disagree, would jump here).
        let worst = 0;
        for (const side of [-1, 1]) {
          let prev = terrainHeight(m.x, m.z);
          let prevNatural = naturalHeight(m.x, m.z);
          for (let d = 0.1; d <= 44; d += 0.1) {
            const x = m.x + m.across[0] * d * side;
            const z = m.z + m.across[1] * d * side;
            const h = terrainHeight(x, z);
            const n = naturalHeight(x, z);
            worst = Math.max(worst, Math.abs(h - prev) - Math.abs(n - prevNatural));
            prev = h;
            prevNatural = n;
          }
        }
        expect(worst, `${r.name} near ${Math.round(m.x)}, ${Math.round(m.z)}`).toBeLessThan(0.2);
      }
    }
    // Tens of thousands of terrain samples: slower than the default limit when the suite runs.
  }, 30_000);

  it('are where the physics and the server put the ground', () => {
    for (const r of city.hillRoads) {
      const ms = middles(r);
      for (const f of [0.25, 0.5, 0.75]) {
        const m = ms[Math.floor(f * (ms.length - 1))];
        if (!m) throw new Error('no middle');
        // In the right-hand lane.
        const [x, z] = [m.x + m.across[0] * 1.75, m.z + m.across[1] * 1.75];
        expect(surfaceAt(x, z, m.y + 5)).toBeCloseTo(m.y, 0);
        expect(heightRange(city, x, z).ground).toBeCloseTo(m.y, 1);
      }
    }
  });

  it('have solid guard rails where the ground falls away, and lamps for the night', () => {
    expect(city.guardRails.length).toBeGreaterThan(0);
    for (const rail of city.guardRails) {
      const p = rail.points[Math.floor(rail.points.length / 2)] as RampPoint;
      expect(surfaceAt(p.x, p.z, p.y + 5)).toBeCloseTo(p.y + 0.8, 1);
      // Something below the road beside it (the drop it guards).
      expect(p.y - terrainHeight(p.x, p.z)).toBeLessThan(0.2);
    }
    const lamps = city.lights.filter((l) => l.y !== undefined);
    expect(lamps.length).toBeGreaterThan(40);
    for (const l of lamps) expect(terrainHeight(l.x, l.z)).toBeCloseTo(l.y as number, 0);
  });

  it('have villas along them, level on their pads, clear of the roads and solid', () => {
    const villas = city.buildings.filter((b) => b.drive);
    expect(villas.length).toBeGreaterThanOrEqual(30);
    for (const v of villas) {
      const y = v.y as number;
      for (const [dx, dz] of [
        [0, 0],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        expect(terrainHeight(v.x + (dx * v.w) / 2, v.z + (dz * v.d) / 2)).toBeCloseTo(y, 1);
      }
      // No road through the house, its front towards the road it stands by.
      for (const r of city.hillRoads) {
        for (const p of r.points) {
          const inside =
            Math.abs(p.x - v.x) < v.w / 2 + HILL_HALF && Math.abs(p.z - v.z) < v.d / 2 + HILL_HALF;
          expect(inside).toBe(false);
        }
      }
      expect(v.drive?.north).toBe((v.drive?.toZ as number) < v.z);
      // Its walls stand in the physics.
      expect(surfaceAt(v.x, v.z, y + 40)).toBeGreaterThan(y + v.h * 0.5);
    }
    for (const a of villas) {
      for (const b of villas) {
        if (a === b) continue;
        const apart =
          Math.abs(a.x - b.x) > (a.w + b.w) / 2 || Math.abs(a.z - b.z) > (a.d + b.d) / 2;
        expect(apart).toBe(true);
      }
    }
  });
});
