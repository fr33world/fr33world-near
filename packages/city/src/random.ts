/** Small seeded PRNG (mulberry32): the same seed builds the same city on client and server. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hiInclusive: number) => lo + Math.floor(next() * (hiInclusive - lo + 1)),
    pick: <T>(list: readonly T[]): T => {
      const item = list[Math.floor(next() * list.length)];
      if (item === undefined) throw new RangeError('pick from empty list');
      return item;
    },
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;

/** Stable 32-bit hash for deriving child seeds (e.g. per building). */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}
