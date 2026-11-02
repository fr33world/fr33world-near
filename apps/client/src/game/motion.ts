/**
 * Smooth motion for other players' cars (Phase 7) between the server's snapshots, which come
 * 30, 15 or 5 times a second by distance (20, 10, 3 on the free plan). Straight lines between
 * them turned corners into chords and changed speed with a jolt at every snapshot; a cubic
 * (Hermite) curve through each pair's positions and velocities keeps both position and speed
 * continuous. When a snapshot is late the car carries on along its velocity; when the next one
 * lands somewhere else, the difference is kept as an offset that fades out quickly instead of
 * a snap (Smoother).
 */

export interface Point {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/**
 * Between snapshot `a` and `b`, `dt` seconds apart, at `k` (0–1): the position and velocity on
 * the curve through both, written into `out`. Velocities that don't fit the distance actually
 * covered (a correction, a respawn) would make the curve swing wide: then a straight line.
 */
export function hermite(a: Point, b: Point, dt: number, k: number, out: Point): Point {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const covered = Math.hypot(dx, dz);
  const expected = ((Math.hypot(a.vx, a.vz) + Math.hypot(b.vx, b.vz)) / 2) * dt;
  if (dt <= 0 || covered > expected * 2 + 3 || expected > covered * 2 + 3) {
    out.x = a.x + dx * k;
    out.z = a.z + dz * k;
    out.vx = dt > 0 ? dx / dt : 0;
    out.vz = dt > 0 ? dz / dt : 0;
    return out;
  }
  const k2 = k * k;
  const k3 = k2 * k;
  const h00 = 2 * k3 - 3 * k2 + 1;
  const h10 = k3 - 2 * k2 + k;
  const h01 = -2 * k3 + 3 * k2;
  const h11 = k3 - k2;
  out.x = h00 * a.x + h10 * dt * a.vx + h01 * b.x + h11 * dt * b.vx;
  out.z = h00 * a.z + h10 * dt * a.vz + h01 * b.z + h11 * dt * b.vz;
  // The curve's own velocity (its derivative over time).
  const d00 = 6 * k2 - 6 * k;
  const d10 = 3 * k2 - 4 * k + 1;
  const d11 = 3 * k2 - 2 * k;
  out.vx = (d00 * (a.x - b.x)) / dt + d10 * a.vx + d11 * b.vx;
  out.vz = (d00 * (a.z - b.z)) / dt + d10 * a.vz + d11 * b.vz;
  return out;
}

/** How fast a leftover offset fades (s), and past what it's a teleport, not a correction (m). */
const FADE = 0.15;
const SNAP = 6;

/**
 * Hides jumps in a body's position: when where it should be now (`x`, `z`) is further from
 * last frame's than its speed explains, the gap is kept and faded out over FADE.
 */
export class Smoother {
  ox = 0;
  oz = 0;
  private px = NaN;
  private pz = NaN;

  /** Takes this frame's position and speed; returns where to draw it (`out`). */
  apply(x: number, z: number, speed: number, dt: number, out: { x: number; z: number }) {
    if (Number.isFinite(this.px)) {
      const jump = Math.hypot(x - this.px, z - this.pz);
      if (jump > speed * dt * 1.5 + 0.25) {
        this.ox += this.px - x;
        this.oz += this.pz - z;
      }
    }
    this.px = x;
    this.pz = z;
    if (Math.hypot(this.ox, this.oz) > SNAP) this.ox = this.oz = 0;
    const keep = Math.exp(-Math.max(0, dt) / FADE);
    this.ox *= keep;
    this.oz *= keep;
    out.x = x + this.ox;
    out.z = z + this.oz;
    return out;
  }
}
