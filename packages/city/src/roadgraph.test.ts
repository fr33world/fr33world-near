import { describe, expect, it } from 'vitest';
import { QUARRY } from './plan.ts';
import { generateCity } from './layout.ts';
import { RoadGraph } from './roadgraph.ts';

describe('road graph', () => {
  const city = generateCity();
  const graph = RoadGraph.fromCity(city);

  it('reaches every part of the city from the plaza along the roads', () => {
    const p = city.plaza;
    const from = [(p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2] as const;
    const targets: [number, number][] = [
      [1100, 600], // the port
      [-700, 1200], // South Grid
      [(QUARRY.x0 + QUARRY.x1) / 2, (QUARRY.z0 + QUARRY.z1) / 2], // the quarry, up Quarry Road
      [city.landmarks.observatory.x, city.landmarks.observatory.z], // up the hill roads
    ];
    for (const [x, z] of targets) {
      const r = graph.route(from[0], from[1], x, z);
      expect(r, `route to ${x}, ${z}`).not.toBeNull();
      if (!r) continue;
      const straight = Math.hypot(x - from[0], z - from[1]);
      // Along roads: never shorter than straight, and not absurdly longer.
      expect(r.length).toBeGreaterThanOrEqual(straight - 1);
      expect(r.length).toBeLessThan(straight * 2.2 + 200);
    }
  });

  it('keeps every step of a route short (no jumps across blocks)', () => {
    const r = graph.route(-64, -45, 900, 400);
    expect(r).not.toBeNull();
    const pts = r?.points ?? [];
    for (let i = 2; i < pts.length - 1; i += 1) {
      const [ax, az] = pts[i - 1] as [number, number];
      const [bx, bz] = pts[i] as [number, number];
      expect(Math.hypot(bx - ax, bz - az)).toBeLessThanOrEqual(24);
    }
  });

  it('is quick enough to plan routes on the fly', () => {
    const t = performance.now();
    for (let i = 0; i < 20; i += 1) graph.route(-64, -45, 1200 - i * 50, 900 - i * 80);
    expect((performance.now() - t) / 20).toBeLessThan(40);
  });
});
