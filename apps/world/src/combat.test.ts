import { describe, expect, it } from 'vitest';
import { direction, hitCharacter, PoseHistory, raySphere, rayVerticalCapsule } from './combat.ts';

describe('ray tests', () => {
  it('hits a sphere at the near surface and misses beside it', () => {
    expect(
      raySphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 10 }, 1),
    ).toBeCloseTo(9);
    expect(raySphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 2, y: 0, z: 10 }, 1)).toBe(
      -1,
    );
    expect(raySphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -10 }, 1)).toBe(
      -1,
    );
  });

  it('hits a vertical capsule on its side and caps', () => {
    const o = { x: 0, y: 1, z: 0 };
    expect(rayVerticalCapsule(o, { x: 0, y: 0, z: 1 }, 0, 5, 0.5, 1.5, 0.3)).toBeCloseTo(4.7);
    expect(rayVerticalCapsule(o, { x: 0, y: 0, z: 1 }, 0, 5, 2, 3, 0.3)).toBe(-1);
    // Straight down onto the top cap.
    expect(
      rayVerticalCapsule({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 0, 0, 0.5, 1.5, 0.3),
    ).toBeCloseTo(3.2);
  });

  it('classifies head, body and leg hits on a character', () => {
    const feet = { x: 0, y: 0, z: 10 };
    const at = (y: number) => hitCharacter({ x: 0, y, z: 0 }, direction(0, 0), feet);
    expect(at(1.62)?.zone).toBe('head');
    expect(at(1.2)?.zone).toBe('body');
    expect(at(0.5)?.zone).toBe('limb');
    expect(at(2.2)).toBeNull();
    expect(hitCharacter({ x: 1, y: 1.2, z: 0 }, direction(0, 0), feet)).toBeNull();
  });
});

describe('pose history', () => {
  it('interpolates between recorded samples and clamps outside them', () => {
    const h = new PoseHistory();
    for (let i = 0; i <= 10; i += 1) h.record(i * 100, i, 0, 0);
    const out = { x: 0, y: 0, z: 0 };
    expect(h.at(550, out)?.x).toBeCloseTo(5.5);
    expect(h.at(5000, out)?.x).toBe(10);
    expect(h.at(-50, out)?.x).toBe(0);
  });

  it('forgets samples older than its window', () => {
    const h = new PoseHistory();
    for (let i = 0; i < PoseHistory.SIZE + 10; i += 1) h.record(i * 33, i, 0, 0);
    const out = { x: 0, y: 0, z: 0 };
    // The oldest kept sample is SIZE samples back from the newest.
    expect(h.at(0, out)?.x).toBe(10);
  });
});
