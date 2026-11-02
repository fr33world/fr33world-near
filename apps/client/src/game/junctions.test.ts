import { carriageHalfWidth, generateCity, type Road, terrainHeight } from '@fr33world/city';
import { beforeAll, describe, expect, it } from 'vitest';
import { junctions, POLE_HEIGHT } from './city/junctions.ts';
import { gardens, PROP_SIZE, propSpots, shelterSpots, treeSpots } from './city/placements.ts';
import { Physics } from './physics.ts';

const city = generateCity();
const all = junctions(city);
let physics: Physics;

beforeAll(async () => {
  physics = await Physics.create(city);
  // Building the whole city's physics: seconds, more with every test file running at once.
}, 60_000);

/** Is (x, z) on a road's carriageway? */
function onCarriageway(r: Road, x: number, z: number): boolean {
  const [along, across] = r.axis === 'ns' ? [z, x] : [x, z];
  return along >= r.from && along <= r.to && Math.abs(across - r.center) <= carriageHalfWidth(r);
}

describe('junctions', () => {
  it('signal the main junctions, four approaches at Sol Boulevard and Grand Avenue', () => {
    expect(all.length).toBeGreaterThan(200);
    const signalled = all.filter((j) => j.signals.length > 0);
    expect(signalled.length).toBeGreaterThan(60);
    const grand = all.find((j) => j.x === 0 && j.z === 0);
    expect(grand?.signals).toHaveLength(4);
    // Quiet side-street crossings: a sign, no signals.
    expect(all.some((j) => j.signals.length === 0 && j.legs.length === 4)).toBe(true);
  });

  it('stand their poles off the road, heads over the lanes of the traffic they face', () => {
    for (const j of all) {
      for (const s of j.signals) {
        for (const r of city.roads) expect(onCarriageway(r, s.x, s.z)).toBe(false);
        const road = s.group === 0 ? j.ns : j.ew;
        for (const along of s.lanes) {
          const [hx, hz] = [s.x + s.arm[0] * along, s.z + s.arm[1] * along];
          // (Over the street: it may be split into segments at the junction.)
          const street = city.roads.filter((r) => r.axis === road.axis && r.center === road.center);
          expect(street.some((r) => onCarriageway(r, hx, hz))).toBe(true);
          // On the side the approaching traffic drives (right-hand traffic).
          const side = s.group === 0 ? Math.sign(hx - j.x) : Math.sign(hz - j.z);
          const expected = { north: -1, south: 1, west: 1, east: -1 }[s.from];
          expect(side).toBe(expected);
        }
      }
      for (const r of city.roads) expect(onCarriageway(r, j.sign.x, j.sign.z)).toBe(false);
    }
  });

  it('are solid in the physics', () => {
    const grand = all.find((j) => j.x === 0 && j.z === 0);
    const pole = grand?.signals[0];
    if (!pole) throw new Error('no signal pole at Grand and Sol');
    const { rapier, world } = physics;
    physics.focus(pole.x, pole.z);
    const hit = world.castRay(
      new rapier.Ray({ x: pole.x, y: 20, z: pole.z }, { x: 0, y: -1, z: 0 }),
      40,
      true,
    );
    expect(20 - (hit?.timeOfImpact ?? 40)).toBeCloseTo(POLE_HEIGHT, 0);
  });
});

describe('street props', () => {
  const spots = propSpots(city);

  it('put hydrants, bins, benches, planters and barriers about the city', () => {
    const count = (k: string) => spots.filter((s) => s.kind === k).length;
    expect(count('hydrant')).toBeGreaterThan(200);
    expect(count('bin')).toBeGreaterThan(200);
    expect(count('bench')).toBeGreaterThan(50);
    expect(count('planter')).toBeGreaterThan(20);
    expect(count('barrier')).toBeGreaterThan(20);
  });

  it('keep off the carriageways, except barriers closing streets that stop dead', () => {
    for (const s of spots) {
      const onRoad = city.roads.some((r) => onCarriageway(r, s.x, s.z));
      expect(onRoad).toBe(s.kind === 'barrier');
    }
  });

  it('are solid in the physics', () => {
    const bench = spots.find((s) => s.kind === 'bench');
    if (!bench) throw new Error('no bench');
    const { rapier, world } = physics;
    physics.focus(bench.x, bench.z);
    const hit = world.castRay(
      new rapier.Ray({ x: bench.x, y: 10, z: bench.z }, { x: 0, y: -1, z: 0 }),
      20,
      true,
    );
    expect(10 - (hit?.timeOfImpact ?? 20)).toBeCloseTo(bench.y + PROP_SIZE.bench.h, 1);
  });
});

describe('flowering trees', () => {
  const trees = treeSpots(city);

  it('line the residential streets, fill the parks and the villas gardens', () => {
    expect(trees.length).toBeGreaterThan(1000);
    expect(trees.some((t) => t.species === 'jacaranda')).toBe(true);
    expect(trees.some((t) => t.species === 'blossom')).toBe(true);
    // In the hills, beside the villas, on their pads.
    expect(trees.filter((t) => t.y > 1).length).toBeGreaterThan(30);
    for (const t of trees) {
      expect(city.roads.some((r) => onCarriageway(r, t.x, t.z))).toBe(false);
    }
  });

  it('have solid trunks', () => {
    const t = trees[0];
    if (!t) throw new Error('no trees');
    const { rapier, world } = physics;
    physics.focus(t.x, t.z);
    const hit = world.castRay(
      new rapier.Ray({ x: t.x - 3, y: t.y + 1.2, z: t.z }, { x: 1, y: 0, z: 0 }),
      6,
      true,
    );
    expect(hit?.timeOfImpact).toBeLessThan(3);
  });
});

describe('gardens', () => {
  const g = gardens(city);

  it('plant flower beds by the houses, in the parks and the plaza, agaves by the villas', () => {
    expect(g.beds.length).toBeGreaterThan(1000);
    expect(g.flowers.length).toBeGreaterThan(5000);
    expect(g.agaves.length).toBeGreaterThan(50);
    // Several colours in use, every flower in a bed or a planter, on the ground.
    expect(new Set(g.flowers.map((f) => f.mix)).size).toBeGreaterThan(4);
    for (const a of g.agaves) expect(Math.abs(a.y - terrainHeight(a.x, a.z))).toBeLessThan(0.3);
    for (const f of g.flowers) {
      expect(city.roads.some((r) => onCarriageway(r, f.x, f.z))).toBe(false);
    }
  });
});

describe('bus shelters', () => {
  const shelters = shelterSpots(city);

  it('stand on the main roads sidewalks, facing the road, clear of the other props', () => {
    expect(shelters.length).toBeGreaterThan(30);
    for (const s of shelters) {
      expect(city.roads.some((r) => onCarriageway(r, s.x, s.z))).toBe(false);
      // The open front looks onto a carriageway a few metres ahead.
      const [fx, fz] = [s.x + Math.sin(s.yaw) * 5, s.z + Math.cos(s.yaw) * 5];
      expect(city.roads.some((r) => onCarriageway(r, fx, fz))).toBe(true);
      for (const p of propSpots(city)) expect(Math.hypot(p.x - s.x, p.z - s.z)).toBeGreaterThan(3);
    }
  });
});
