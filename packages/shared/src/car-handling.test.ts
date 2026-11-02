import { describe, expect, it } from 'vitest';
import { CAR_MODELS } from './car-models.ts';
import { engineRevs, HANDLING, handlingOf } from './car-handling.ts';

describe('car handling', () => {
  it('has a handling and a sound for every model', () => {
    for (const m of CAR_MODELS) expect(HANDLING[m.id], m.id).toBeDefined();
    expect(handlingOf('nothing')).toBe(HANDLING.sedan);
  });

  it('revs climb through each gear and drop back at the shift', () => {
    const revs = (v: number) => engineRevs(v, 50, 5, 0);
    expect(revs(0)).toBeCloseTo(0.18, 2);
    // Within first gear (up to (1/5)^0.8 of the top: about 13.8 m/s) the revs rise...
    expect(revs(10)).toBeGreaterThan(revs(5));
    // ...then fall when it shifts into second.
    expect(revs(14.5)).toBeLessThan(revs(13.5));
    for (let v = 0; v <= 60; v += 0.5) {
      expect(revs(v)).toBeGreaterThanOrEqual(0);
      expect(revs(v)).toBeLessThanOrEqual(1);
    }
    // The throttle adds a little.
    expect(engineRevs(20, 50, 5, 1)).toBeGreaterThan(revs(20));
  });
});
