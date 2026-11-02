import { describe, expect, it } from 'vitest';
import { sunAngle } from './sky.ts';

const up = (hour: number) => Math.sin(sunAngle(hour));

describe('the sun', () => {
  it('is up through the afternoon and the early morning, highest at noon', () => {
    for (const hour of [6, 8, 16, 17, 18, 18.5]) expect(up(hour)).toBeGreaterThan(0);
    expect(up(12)).toBeCloseTo(1);
    for (const hour of [20, 23, 0, 3]) expect(up(hour)).toBeLessThan(0);
  });

  it('never jumps, round the whole day', () => {
    const round = (hour: number) => [Math.cos(sunAngle(hour)), Math.sin(sunAngle(hour))];
    for (let hour = 0; hour < 24; hour += 0.05) {
      const [ax = 0, ay = 0] = round(hour);
      const [bx = 0, by = 0] = round(hour + 0.05);
      expect(Math.hypot(bx - ax, by - ay)).toBeLessThan(0.05);
    }
  });
});
