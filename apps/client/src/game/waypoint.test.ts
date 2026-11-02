import { Footpaths, generateCity, type InteractionPoint, RoadGraph } from '@fr33world/city';
import { beforeAll, describe, expect, it } from 'vitest';
import { Physics } from './physics.ts';
import { furniture } from './waypoint.ts';

const city = generateCity();
let physics: Physics;

beforeAll(async () => {
  physics = await Physics.create(city);
}, 60_000);

/** A body standing on the ground at (x, z) touches something, by the real colliders. */
function touching(x: number, z: number): boolean {
  const { rapier, world } = physics;
  physics.focus(x, z);
  const down = world.castRay(new rapier.Ray({ x, y: 80, z }, { x: 0, y: -1, z: 0 }), 200, true);
  const y = down ? 80 - down.timeOfImpact : 0;
  const body = new rapier.Capsule(0.45, 0.3);
  return !!world.intersectionWithShape({ x, y: y + 1.05, z }, { x: 0, y: 0, z: 0, w: 1 }, body);
}

describe('ways on foot, against the real colliders', () => {
  it('leaves nothing in the way, furniture included', () => {
    const paths = new Footpaths(city, RoadGraph.fromCity(city), furniture(city));
    const pts = city.points;
    const place = (kind: string) => pts.find((p) => p.kind === kind) as InteractionPoint;
    const trips: { from: { x: number; z: number }; to: { x: number; z: number } }[] = [];
    for (const from of city.playerSpawns)
      for (const to of [place('info'), place('depot')]) trips.push({ from, to });
    for (let i = 0; i < pts.length; i += 1)
      for (let j = i + 1; j < pts.length; j += 1) {
        const [a, b] = [pts[i], pts[j]] as [InteractionPoint, InteractionPoint];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > 12 && d < 250 && (i + j) % 61 === 0) trips.push({ from: a, to: b });
      }
    let walked = 0;
    for (const { from, to } of trips) {
      const r = paths.route(from.x, from.z, to.x, to.z);
      if (!r?.offRoad) continue;
      walked += 1;
      // The two ends stand by whatever they're the door or lockers of.
      for (let k = 2; k < r.points.length - 1; k += 1) {
        const [ax, az] = r.points[k - 1] as [number, number];
        const [bx, bz] = r.points[k] as [number, number];
        const n = Math.ceil(Math.hypot(bx - ax, bz - az) * 2);
        for (let q = 0; q <= n; q += 1) {
          const [x, z] = [ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n];
          expect(touching(x, z), `${from.x}, ${from.z} to ${to.x}, ${to.z} at ${x}, ${z}`).toBe(
            false,
          );
        }
      }
    }
    expect(walked).toBeGreaterThan(50);
  });
});
