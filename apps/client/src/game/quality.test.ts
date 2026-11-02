import { describe, expect, it } from 'vitest';
import { autoTier, MIN_RESOLUTION, ResolutionGovernor } from './quality.ts';

describe('Auto graphics starting tier', () => {
  it('reads phones by memory and cores', () => {
    expect(autoTier(true, 2, 8, '')).toBe('low');
    expect(autoTier(true, 8, 4, '')).toBe('low');
    expect(autoTier(true, 8, 8, 'Apple GPU')).toBe('medium');
  });

  it('starts budget phone GPUs at Low, however many cores they have', () => {
    expect(autoTier(true, 8, 8, 'ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)')).toBe('low');
    expect(autoTier(true, 8, 8, 'Mali-G57')).toBe('low');
    expect(autoTier(true, 8, 8, 'Adreno (TM) 610')).toBe('low');
    expect(autoTier(true, 8, 8, 'PowerVR Rogue GE8320')).toBe('low');
    expect(autoTier(true, 8, 8, 'Adreno (TM) 730')).toBe('medium');
    expect(autoTier(true, 8, 8, 'Mali-G710 MC10')).toBe('medium');
  });

  it('starts laptops with older Intel graphics low, others at Medium or High', () => {
    expect(autoTier(false, 8, 8, 'Intel(R) HD Graphics 6000')).toBe('low');
    expect(autoTier(false, 8, 8, 'ANGLE (Intel, Intel(R) UHD Graphics 620)')).toBe('medium');
    expect(autoTier(false, 8, 8, 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)')).toBe('high');
    expect(autoTier(false, 16, 12, 'ANGLE (NVIDIA, GeForce RTX 3060)')).toBe('high');
    expect(autoTier(false, 8, 8, 'Apple M2')).toBe('high');
  });
});

describe('Resolution governor', () => {
  const frames = (ms: number, n = 60) => Array<number>(n).fill(ms);

  it('ignores a stall or two in an otherwise good run', () => {
    const g = new ResolutionGovernor();
    const stalls = [...frames(17, 100), 400, 600, 900];
    for (let i = 0; i < 20; i += 1) expect(g.check(stalls, i * 2000)).toBe(1);
  });

  it('comes down for a burst of stalls, which is the GPU falling behind', () => {
    const g = new ResolutionGovernor(33);
    g.check([...frames(33, 54), 140, 110, 130, 120], 2000);
    expect(g.scale).toBeLessThan(1);
  });

  it('comes down when the device really is slow, but never below the floor', () => {
    const g = new ResolutionGovernor();
    let scale = 1;
    for (let i = 0; i < 20; i += 1) scale = g.check(frames(50), i * 2000);
    expect(scale).toBe(MIN_RESOLUTION);
  });

  it('holds its resolution while the frame rate is merely uneven', () => {
    const g = new ResolutionGovernor();
    g.check(frames(50), 0);
    const held = g.scale;
    for (let i = 1; i < 30; i += 1) g.check([...frames(17, 30), ...frames(33, 30)], i * 2000);
    expect(g.scale).toBe(held);
  });

  it('climbs back when there is room, at a capped frame rate too', () => {
    const g = new ResolutionGovernor(33);
    for (let i = 0; i < 5; i += 1) g.check(frames(50), i * 2000);
    expect(g.scale).toBeLessThan(0.8);
    for (let i = 5; i < 80; i += 1) g.check(frames(33), i * 2000);
    expect(g.scale).toBe(1);
  });

  it('waits longer each time going up fails', () => {
    const g = new ResolutionGovernor();
    g.check(frames(50), 0);
    let changes = 0;
    let scale = g.scale;
    // At this scale it's fine; one step up it isn't.
    for (let i = 1; i < 300; i += 1) {
      const next = g.check(frames(g.scale >= 0.9 ? 50 : 17), i * 2000);
      if (next !== scale) changes += 1;
      scale = next;
    }
    expect(scale).toBeLessThan(1);
    // Swinging every 8 seconds would be about 75 changes.
    expect(changes).toBeLessThan(16);
  });
});
