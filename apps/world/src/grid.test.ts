import { describe, expect, it } from 'vitest';
import { selectInPlace, SpatialGrid } from './grid.ts';

describe('selectInPlace', () => {
  it('finds the k-th smallest and leaves the k+1 smallest in front, cascading', () => {
    for (let trial = 0; trial < 50; trial += 1) {
      const n = 1 + Math.floor(Math.random() * 600);
      const values = Float64Array.from({ length: n }, () => Math.floor(Math.random() * 100));
      const sorted = [...values].sort((a, b) => a - b);
      let m = n;
      for (const k of [127, 63, 15]) {
        if (k >= m) continue;
        const got = selectInPlace(values, m, k);
        expect(got).toBe(sorted[k]);
        const front = [...values.subarray(0, k + 1)].sort((a, b) => a - b);
        expect(front).toEqual(sorted.slice(0, k + 1));
        m = k + 1;
      }
    }
  });

  it('returns Infinity when k is past the end', () => {
    expect(selectInPlace(new Float64Array([1, 2]), 2, 5)).toBe(Infinity);
  });
});

describe('SpatialGrid', () => {
  it('finds entities in nearby cells and forgets removed ones', () => {
    const grid = new SpatialGrid(100);
    grid.upsert(1, 10, 10);
    grid.upsert(2, 150, 10);
    grid.upsert(3, 900, 900);
    expect(grid.query(0, 0, 160, []).sort()).toEqual([1, 2]);
    grid.upsert(2, 950, 950);
    grid.remove(1);
    expect(grid.query(0, 0, 160, [])).toEqual([]);
    expect(grid.query(920, 920, 50, []).sort()).toEqual([2, 3]);
  });
});
