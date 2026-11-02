/**
 * Static collision for server-side movement validation (technical-plan §7.2): building
 * footprints, freeway pillars and landmark solids as 2D boxes in a uniform grid, queried with
 * swept segments so a body cannot pass through a wall between two reports. Pillars carry their
 * height: a car on the deck or ramp above them passes over, not through.
 */
import type { CityLayout, Rect } from './layout.ts';
import { DECK_DEPTH } from './ramps.ts';

/** A box, and how high it stands when that's below a deck someone can drive over (m). */
export type Solid2D = Rect & { top?: number };

/** A body this far below a pillar's top still counts as beside it, not over it (m). */
const OVER_MARGIN = 1.5;

export class CollisionIndex {
  private readonly cells = new Map<number, Solid2D[]>();
  readonly boxes: readonly Solid2D[];
  private readonly cellSize: number;

  constructor(boxes: Solid2D[], cellSize = 32) {
    this.boxes = boxes;
    this.cellSize = cellSize;
    for (const b of boxes) {
      for (let cx = this.cell(b.x0); cx <= this.cell(b.x1); cx += 1) {
        for (let cz = this.cell(b.z0); cz <= this.cell(b.z1); cz += 1) {
          const k = key(cx, cz);
          const list = this.cells.get(k);
          if (list) list.push(b);
          else this.cells.set(k, [b]);
        }
      }
    }
  }

  static fromCity(city: CityLayout): CollisionIndex {
    const boxes: Solid2D[] = city.buildings.map((b) => ({
      x0: b.x - b.w / 2,
      x1: b.x + b.w / 2,
      z0: b.z - b.d / 2,
      z1: b.z + b.d / 2,
    }));
    for (const s of city.solids) boxes.push({ x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1 });
    for (const r of city.ramps) {
      for (const p of r.pillars) {
        boxes.push({
          x0: p.x - p.w / 2,
          x1: p.x + p.w / 2,
          z0: p.z - p.d / 2,
          z1: p.z + p.d / 2,
          top: p.top,
        });
      }
    }
    for (const fw of city.freeways) {
      for (const p of fw.pillars) {
        boxes.push({
          x0: p.x - p.w / 2,
          x1: p.x + p.w / 2,
          z0: p.z - p.d / 2,
          z1: p.z + p.d / 2,
          top: fw.deckY - DECK_DEPTH,
        });
      }
    }
    return new CollisionIndex(boxes);
  }

  private cell(v: number) {
    return Math.floor(v / this.cellSize);
  }

  /** True when a circle of `radius` at (x, z) overlaps a box (at height `y`, when given). */
  pointBlocked(x: number, z: number, radius: number, y = -Infinity): boolean {
    return this.segmentBlocked(x, z, x, z, radius, y);
  }

  /**
   * True when a circle of `radius` moving from (x0, z0) to (x1, z1) touches a box anywhere
   * along the way. Boxes are expanded by the radius (a slightly generous rounded test, which
   * errs towards allowing movement near corners rather than rejecting honest players). A body
   * at height `y` (its lowest along the way) passes over pillars whose tops are below it.
   */
  segmentBlocked(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    radius: number,
    y = -Infinity,
  ): boolean {
    const cx0 = this.cell(Math.min(x0, x1) - radius);
    const cx1 = this.cell(Math.max(x0, x1) + radius);
    const cz0 = this.cell(Math.min(z0, z1) - radius);
    const cz1 = this.cell(Math.max(z0, z1) + radius);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cz = cz0; cz <= cz1; cz += 1) {
        const list = this.cells.get(key(cx, cz));
        if (!list) continue;
        for (const b of list) {
          if (b.top !== undefined && y > b.top - OVER_MARGIN) continue;
          if (
            segmentHitsBox(
              x0,
              z0,
              x1,
              z1,
              b.x0 - radius,
              b.z0 - radius,
              b.x1 + radius,
              b.z1 + radius,
            )
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

/** Slab test of segment p0→p1 against an axis-aligned box (strict interior). */
function segmentHitsBox(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  bx0: number,
  bz0: number,
  bx1: number,
  bz1: number,
): boolean {
  let tMin = 0;
  let tMax = 1;
  const dx = x1 - x0;
  const dz = z1 - z0;
  for (const [p, d, lo, hi] of [
    [x0, dx, bx0, bx1],
    [z0, dz, bz0, bz1],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (p <= lo || p >= hi) return false;
    } else {
      let t0 = (lo - p) / d;
      let t1 = (hi - p) / d;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tMin = Math.max(tMin, t0);
      tMax = Math.min(tMax, t1);
      if (tMin >= tMax) return false;
    }
  }
  return true;
}
