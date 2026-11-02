import {
  COAST,
  coastDistance,
  generateCity,
  inside,
  isLand,
  isWalkable,
  LAKE,
  RIVER,
  RIVER_DEPTH,
  RIVER_FLOOR,
  TERRAIN_STEP,
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

/** Height of the first thing straight down from high above (x, z). */
function groundAt(x: number, z: number): number {
  const { rapier, world } = physics;
  physics.focus(x, z);
  const ray = new rapier.Ray({ x, y: 800, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, 1000, true);
  if (!hit) throw new Error(`no ground at ${x}, ${z}`);
  return 800 - hit.timeOfImpact;
}

describe('terrain', () => {
  it('is flat in the city, with mountains in the north, on an island', () => {
    expect(terrainHeight(-60, -60)).toBe(0);
    expect(terrainHeight(1000, 800)).toBe(0);
    let peak = 0;
    for (let x = -1200; x <= 1200; x += 40) {
      for (let z = -1440; z <= -1000; z += 40) peak = Math.max(peak, terrainHeight(x, z));
    }
    expect(peak).toBeGreaterThan(250);
    // Peaks too steep to climb (the player's limit is 50°) somewhere in the range.
    let steepest = 0;
    for (let x = -1200; x <= 1200; x += 20) {
      for (let z = -1440; z <= -1000; z += 20) {
        const rise = Math.abs(terrainHeight(x, z + 4) - terrainHeight(x, z));
        steepest = Math.max(steepest, Math.atan2(rise, 4) * (180 / Math.PI));
      }
    }
    expect(steepest).toBeGreaterThan(55);
    // Sea all round: nothing at the world's edge is land, and the shore is a beach at sea level.
    for (let a = -1536; a <= 1536; a += 32) {
      for (const [x, z] of [
        [a, -1536],
        [a, 1536],
        [-1536, a],
        [1536, a],
      ] as const) {
        expect(isLand(x, z)).toBe(false);
      }
    }
    for (const [cx, cz] of COAST) {
      for (const [dx, dz] of [
        [20, 0],
        [-20, 0],
        [0, 20],
        [0, -20],
      ] as const) {
        const [x, z] = [cx + dx, cz + dz];
        if (isLand(x, z) && !inside(RIVER, x, z) && coastDistance(x, z) < 30) {
          // At sea level; the Coast Road's bank lifts it a little under the cliffs.
          expect(terrainHeight(x, z)).toBeGreaterThanOrEqual(0);
          expect(terrainHeight(x, z)).toBeLessThan(2.5);
        }
      }
    }
  });

  it('sinks the river into a channel with a ramp at its north end', () => {
    const mid = (RIVER_FLOOR.x0 + RIVER_FLOOR.x1) / 2;
    expect(terrainHeight(mid, 0)).toBeCloseTo(-RIVER_DEPTH);
    expect(terrainHeight(RIVER.x0, 0)).toBeCloseTo(0);
    expect(terrainHeight(mid, RIVER.z0)).toBeCloseTo(0);
  });

  it('gives the physics the same ground: heightfields line up with the samples', () => {
    const points: [number, number][] = [
      [-400, -1000],
      [-160, -1150],
      [800, -1300],
      [1200, -1150],
      [-1100, -1300],
      [RIVER.x0 + 8, 300],
      [RIVER_FLOOR.x0 + 12, -500],
      [RIVER.x1 - 4, 900],
      [652, RIVER.z0 + 40],
    ];
    for (const [x, z] of points) {
      // Next to sample points: exact whatever the triangulation. (Not on them: Rapier's ray
      // test can slip down a heightfield cell's edge when a ray runs exactly along it.)
      const gx = Math.round(x / TERRAIN_STEP) * TERRAIN_STEP + 0.001;
      const gz = Math.round(z / TERRAIN_STEP) * TERRAIN_STEP + 0.001;
      expect(groundAt(gx, gz)).toBeCloseTo(terrainHeight(gx, gz), 1);
    }
  });

  it('carries the main roads over the river on bridges at street level', () => {
    expect(city.bridges.length).toBeGreaterThanOrEqual(4);
    const b = city.bridges[0];
    if (!b) throw new Error('no bridge');
    const mid = (b.x0 + b.x1) / 2;
    // In a lane (the boulevard's bridge carries its planted median down the middle).
    expect(groundAt(mid, b.z + b.carriage / 2)).toBeCloseTo(0, 2);
    // Beside the bridge, down into the channel.
    expect(groundAt(mid, b.z + b.half + 6)).toBeLessThan(-RIVER_DEPTH + 0.1);
  });

  it('holds a lake in the hills: water over its bed, a dry rim, kept out of it', () => {
    expect(terrainHeight(LAKE.x, LAKE.z)).toBeLessThan(LAKE.level - 3);
    expect(isWalkable(LAKE.x, LAKE.z)).toBe(false);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      // On the rim, just outside the water: dry ground above the water's level.
      const x = LAKE.x + Math.cos(a) * (LAKE.rx + 3);
      const z = LAKE.z + Math.sin(a) * (LAKE.rz + 3);
      expect(terrainHeight(x, z)).toBeCloseTo(LAKE.level + 1.5, 1);
      expect(isWalkable(x, z)).toBe(true);
    }
    // A body walking from the rim into the water meets a wall at its edge.
    const { rapier, world } = physics;
    physics.focus(LAKE.x, LAKE.z + LAKE.rz + 3);
    const ray = new rapier.Ray(
      { x: LAKE.x, y: LAKE.level + 2.5, z: LAKE.z + LAKE.rz + 3 },
      { x: 0, y: 0, z: -1 },
    );
    const hit = world.castRay(ray, 20, true);
    expect(hit?.timeOfImpact).toBeLessThan(6);
  });
});
