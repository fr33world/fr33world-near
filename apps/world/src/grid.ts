/**
 * Uniform spatial grid for interest management. Cells are keyed by a single number and hold
 * entity ids; queries write into a caller-owned array so the tick loop allocates nothing.
 */
export class SpatialGrid {
  private readonly cells = new Map<number, Set<number>>();
  private readonly where = new Map<number, number>();
  private readonly size: number;

  constructor(cellSize: number) {
    this.size = cellSize;
  }

  private key(x: number, z: number) {
    return (Math.floor(x / this.size) + 32768) * 65536 + (Math.floor(z / this.size) + 32768);
  }

  upsert(id: number, x: number, z: number): void {
    const next = this.key(x, z);
    const prev = this.where.get(id);
    if (prev === next) return;
    if (prev !== undefined) this.cells.get(prev)?.delete(id);
    let cell = this.cells.get(next);
    if (!cell) this.cells.set(next, (cell = new Set()));
    cell.add(id);
    this.where.set(id, next);
  }

  remove(id: number): void {
    const prev = this.where.get(id);
    if (prev !== undefined) this.cells.get(prev)?.delete(id);
    this.where.delete(id);
  }

  /** Ids in every cell touching the square of half-size `radius` around (x, z). */
  query(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const cx0 = Math.floor((x - radius) / this.size);
    const cx1 = Math.floor((x + radius) / this.size);
    const cz0 = Math.floor((z - radius) / this.size);
    const cz1 = Math.floor((z + radius) / this.size);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cz = cz0; cz <= cz1; cz += 1) {
        const cell = this.cells.get((cx + 32768) * 65536 + (cz + 32768));
        if (cell) for (const id of cell) out.push(id);
      }
    }
    return out;
  }
}

/**
 * Quickselect: rearranges the first `n` entries in place so the k+1 smallest occupy [0, k],
 * and returns the k-th smallest (0-based). Because the prefix is then the k+1 smallest, the
 * "nearest 128 / 64 / 16" cut-offs cascade on shrinking prefixes in O(n) total.
 */
export function selectInPlace(scratch: Float64Array, n: number, k: number): number {
  if (k >= n) return Infinity;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = scratch[(lo + hi) >> 1] as number;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while ((scratch[i] as number) < pivot) i += 1;
      while ((scratch[j] as number) > pivot) j -= 1;
      if (i <= j) {
        const t = scratch[i] as number;
        scratch[i] = scratch[j] as number;
        scratch[j] = t;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return scratch[k] as number;
}
