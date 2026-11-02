import { describe, expect, it } from 'vitest';
import { hermite, type Point, Smoother } from './motion.ts';

/** A car going round a 25 m circle at 18 m/s: where it is and how it moves at time t (s). */
function circle(t: number): Point {
  const r = 25;
  const w = 18 / r;
  return {
    x: r * Math.cos(w * t),
    z: r * Math.sin(w * t),
    vx: -r * w * Math.sin(w * t),
    vz: r * w * Math.cos(w * t),
  };
}

describe('remote car motion', () => {
  it('follows a bend between 5 Hz snapshots far closer than straight lines do', () => {
    const dt = 0.2;
    const out: Point = { x: 0, z: 0, vx: 0, vz: 0 };
    let curved = 0;
    let straight = 0;
    for (let t = 0; t < 4; t += dt) {
      const a = circle(t);
      const b = circle(t + dt);
      for (let k = 0.1; k < 1; k += 0.2) {
        const truth = circle(t + k * dt);
        hermite(a, b, dt, k, out);
        curved = Math.max(curved, Math.hypot(out.x - truth.x, out.z - truth.z));
        const lx = a.x + (b.x - a.x) * k;
        const lz = a.z + (b.z - a.z) * k;
        straight = Math.max(straight, Math.hypot(lx - truth.x, lz - truth.z));
      }
    }
    expect(curved).toBeLessThan(straight / 10);
    expect(curved).toBeLessThan(0.01);
  });

  it('keeps speed continuous across a snapshot (no jolt at each one)', () => {
    const out: Point = { x: 0, z: 0, vx: 0, vz: 0 };
    const [a, b, c] = [circle(0), circle(0.2), circle(0.4)];
    const end = { ...hermite(a, b, 0.2, 1, out) };
    const start = { ...hermite(b, c, 0.2, 0, out) };
    expect(Math.hypot(end.vx - start.vx, end.vz - start.vz)).toBeLessThan(1e-9);
  });

  it('draws a straight line when the velocities don’t fit the distance (a teleport)', () => {
    const out: Point = { x: 0, z: 0, vx: 0, vz: 0 };
    hermite({ x: 0, z: 0, vx: 20, vz: 0 }, { x: 0, z: 200, vx: 20, vz: 0 }, 0.2, 0.5, out);
    expect(out).toMatchObject({ x: 0, z: 100 });
  });

  it('turns a jump into a glide that fades in a few frames, but lets a teleport through', () => {
    const s = new Smoother();
    const out = { x: 0, z: 0 };
    // Driving along x at 10 m/s, 60 frames a second, then a correction moves it 1.5 m on.
    let x = 0;
    for (let i = 0; i < 30; i += 1) s.apply((x += 10 / 60), 0, 10, 1 / 60, out);
    const before = out.x;
    s.apply((x += 10 / 60 + 1.5), 0, 10, 1 / 60, out);
    expect(out.x - before).toBeLessThan(0.3);
    for (let i = 0; i < 40; i += 1) s.apply((x += 10 / 60), 0, 10, 1 / 60, out);
    expect(Math.abs(out.x - x)).toBeLessThan(0.02);
    // A respawn far away: drawn there at once.
    s.apply(x + 500, 0, 10, 1 / 60, out);
    expect(out.x).toBe(x + 500);
  });
});
