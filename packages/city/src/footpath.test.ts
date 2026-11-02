import { describe, expect, it } from 'vitest';
import { CollisionIndex } from './collision.ts';
import { FOUNTAIN_RADIUS, Footpaths } from './footpath.ts';
import { generateCity } from './layout.ts';
import { inside, isWalkable, PIER, QUARRY, RIVER } from './plan.ts';
import { RoadGraph } from './roadgraph.ts';
import { terrainHeight } from './terrain.ts';

describe('ways on foot', () => {
  const city = generateCity();
  const graph = RoadGraph.fromCity(city);
  const paths = new Footpaths(city, graph);
  const walls = CollisionIndex.fromCity(city);
  const place = (kind: string) => {
    const p = city.points.find((q) => q.kind === kind);
    if (!p) throw new Error(`no ${kind}`);
    return p;
  };
  const near = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);

  /** Everywhere along a route, a metre apart. */
  const along = (points: [number, number][]) => {
    const out: [number, number][] = [];
    for (let i = 1; i < points.length; i += 1) {
      const [ax, az] = points[i - 1] as [number, number];
      const [bx, bz] = points[i] as [number, number];
      const n = Math.ceil(Math.hypot(bx - ax, bz - az));
      for (let k = 0; k <= n; k += 1)
        out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    return out;
  };

  it('goes straight to the kiosk and the depot from wherever a newcomer starts', () => {
    for (const s of city.playerSpawns)
      for (const t of [place('info'), place('depot')]) {
        const r = paths.route(s.x, s.z, t.x, t.z);
        expect(r?.offRoad, `from ${s.x}, ${s.z} to ${t.kind}`).toBe(true);
        // Round the fountain or the kiosk at most.
        expect(r?.length).toBeLessThan(near(s, t) * 1.2 + 4);
      }
  });

  it('goes round the fountain, not through it', () => {
    const p = city.plaza;
    const [cx, cz] = [(p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2];
    const r = paths.route(cx + 30, cz, cx - 30, cz);
    expect(r?.offRoad).toBe(true);
    for (const [x, z] of along(r?.points ?? []))
      expect(Math.hypot(x - cx, z - cz)).toBeGreaterThan(FOUNTAIN_RADIUS);
    expect(r?.length).toBeLessThan(75);
  });

  it('never cuts through a building, whichever two doors it joins', () => {
    const doors = city.points.filter((q) => q.kind === 'door');
    let cut = 0;
    for (let i = 0; i < doors.length; i += 1)
      for (let j = i + 1; j < doors.length; j += 1) {
        const [a, b] = [doors[i], doors[j]] as [(typeof doors)[0], (typeof doors)[0]];
        if (near(a, b) > 250 || (i + j) % 17 !== 0) continue;
        const r = paths.route(a.x, a.z, b.x, b.z);
        if (!r?.offRoad) continue;
        cut += 1;
        const legs = r.points;
        // The two ends stand beside a wall, by a door.
        for (let k = 3; k < legs.length - 2; k += 1) {
          const [ax, az] = legs[k - 1] as [number, number];
          const [bx, bz] = legs[k] as [number, number];
          expect(walls.segmentBlocked(ax, az, bx, bz, 0.4), `${a.name} to ${b.name}`).toBe(false);
        }
      }
    expect(cut).toBeGreaterThan(20);
  });

  it('crosses the river by a bridge, not down through the channel', () => {
    const bridge = city.bridges[Math.floor(city.bridges.length / 2)];
    if (!bridge) throw new Error('no bridges');
    const z = bridge.z + 60;
    const r = paths.route(RIVER.x0 - 30, z, RIVER.x1 + 30, z);
    expect(r).not.toBeNull();
    for (const [x, zz] of along(r?.points ?? []))
      if (inside(RIVER, x, zz)) expect(Math.abs(zz - bridge.z)).toBeLessThan(bridge.half + 40);
  });

  it('stays out of the sea, off the pier and past the end of it', () => {
    const pier = PIER[1] as (typeof PIER)[number];
    const r = paths.route(pier.x0 + 10, pier.z1 - 4, pier.x1 + 150, pier.z1 + 30);
    expect(r?.offRoad).toBe(true);
    for (const [x, z] of along(r?.points.slice(1, -1) ?? []))
      expect(isWalkable(x, z), `at ${x}, ${z}`).toBe(true);
  });

  it('keeps off slopes too steep to climb', () => {
    const faces = city.points.filter((q) => q.kind === 'ore');
    for (const a of faces)
      for (const b of faces) {
        const r = near(a, b) < 250 ? paths.route(a.x, a.z, b.x, b.z) : null;
        if (!r?.offRoad) continue;
        const ground = along(r.points);
        for (let i = 8; i < ground.length; i += 8) {
          const [px, pz] = ground[i - 8] as [number, number];
          const [qx, qz] = ground[i] as [number, number];
          expect(Math.abs(terrainHeight(qx, qz) - terrainHeight(px, pz))).toBeLessThan(8);
        }
      }
    // And it is a walk across the pit, not the long way round by the road.
    const r = paths.route(QUARRY.x0 + 90, QUARRY.z0 + 90, QUARRY.x0 + 230, QUARRY.z0 + 120);
    expect(r?.length).toBeLessThan(200);
  });

  it('leaves a trip across town to the roads', () => {
    const p = city.plaza;
    const [cx, cz] = [(p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2];
    for (const [x, z] of [
      [1100, 600],
      [-700, 1200],
      [city.landmarks.observatory.x, city.landmarks.observatory.z],
    ] as const) {
      const road = graph.route(cx + 40, cz, x, z);
      const r = paths.route(cx + 40, cz, x, z);
      expect(r?.offRoad).toBeUndefined();
      // Never longer, and all but the two ends the same way.
      expect(r?.length).toBeLessThanOrEqual((road?.length ?? 0) + 1);
      expect(r?.length).toBeGreaterThan((road?.length ?? 0) - 400);
      const roadPoints = new Set(road?.points.map(([a, b]) => `${a},${b}`));
      const kept = r?.points.filter(([a, b]) => roadPoints.has(`${a},${b}`)).length ?? 0;
      expect(kept).toBeGreaterThan((road?.points.length ?? 0) * 0.5);
    }
  });

  it('walking along a street stays on the street', () => {
    const road = city.roads.find(
      (r) => r.lanesPerDir >= 2 && r.axis === 'ew' && r.to - r.from > 800,
    );
    if (!road) throw new Error('no long road');
    const [ax, az] = [road.from + 100, road.center];
    const [bx, bz] = [road.from + 320, road.center];
    const r = paths.route(ax, az, bx, bz);
    expect(r?.length).toBeCloseTo(220, -1);
  });

  it('still finds a way to a mark on a roof or out at sea', () => {
    const b = city.buildings.find((q) => q.w > 30 && q.d > 30);
    if (!b) throw new Error('no big building');
    expect(paths.route(b.x + b.w, b.z + b.d, b.x, b.z)).not.toBeNull();
    const p = PIER[0] as (typeof PIER)[number];
    expect(paths.route(p.x1 + 30, 0, p.x1 + 30, 400)).not.toBeNull();
  });

  it('plans quickly enough for a phone', () => {
    const doors = city.points.filter((q) => q.kind === 'door');
    const pairs: [number, number, number, number][] = [];
    for (let i = 0; i < doors.length; i += 1)
      for (let j = i + 1; j < doors.length; j += 1) {
        const [a, b] = [doors[i], doors[j]] as [(typeof doors)[0], (typeof doors)[0]];
        if (near(a, b) < 250 && (i + j) % 53 === 0) pairs.push([a.x, a.z, b.x, b.z]);
      }
    expect(pairs.length).toBeGreaterThan(10);
    for (const [a, b, c, d] of pairs) paths.route(a, b, c, d);
    const cpu = process.cpuUsage();
    for (const [a, b, c, d] of pairs) paths.route(a, b, c, d);
    const used = process.cpuUsage(cpu);
    expect((used.user + used.system) / 1000 / pairs.length).toBeLessThan(15);
  });
});
