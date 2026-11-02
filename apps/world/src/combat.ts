/**
 * Server-side hit resolution with lag compensation (technical-plan §9). Each player keeps a
 * short history of positions; a shot is tested against targets rewound to the moment the
 * shooter saw them (capped), using capsule (body) and sphere (head) hitboxes, and is blocked
 * by buildings between the muzzle and the hit.
 */
import { HITBOX, LAG_HISTORY_MS, TICK_HZ } from '@fr33world/shared';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Ring buffer of (time, x, y, z) samples taken every tick. */
export class PoseHistory {
  static readonly SIZE = Math.ceil((LAG_HISTORY_MS / 1000) * TICK_HZ) + 2;
  private readonly data = new Float64Array(PoseHistory.SIZE * 4);
  private head = 0;
  private count = 0;

  record(t: number, x: number, y: number, z: number): void {
    const i = this.head * 4;
    this.data[i] = t;
    this.data[i + 1] = x;
    this.data[i + 2] = y;
    this.data[i + 3] = z;
    this.head = (this.head + 1) % PoseHistory.SIZE;
    if (this.count < PoseHistory.SIZE) this.count += 1;
  }

  /** Position at time t, interpolated between samples; clamped to the oldest/newest. */
  at(t: number, out: Vec3): Vec3 | null {
    if (this.count === 0) return null;
    const size = PoseHistory.SIZE;
    // Walk from newest to oldest.
    let newer = -1;
    for (let k = 0; k < this.count; k += 1) {
      const idx = ((this.head - 1 - k + size) % size) * 4;
      const st = this.data[idx] as number;
      if (st <= t) {
        if (newer < 0) return this.read(idx, out);
        const nt = this.data[newer] as number;
        const f = nt > st ? (t - st) / (nt - st) : 0;
        out.x =
          (this.data[idx + 1] as number) +
          ((this.data[newer + 1] as number) - (this.data[idx + 1] as number)) * f;
        out.y =
          (this.data[idx + 2] as number) +
          ((this.data[newer + 2] as number) - (this.data[idx + 2] as number)) * f;
        out.z =
          (this.data[idx + 3] as number) +
          ((this.data[newer + 3] as number) - (this.data[idx + 3] as number)) * f;
        return out;
      }
      newer = idx;
    }
    return this.read(newer, out);
  }

  private read(idx: number, out: Vec3): Vec3 {
    out.x = this.data[idx + 1] as number;
    out.y = this.data[idx + 2] as number;
    out.z = this.data[idx + 3] as number;
    return out;
  }
}

/** Distance along a unit ray to a sphere, or -1. */
export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

/**
 * Distance along a unit ray to a vertical capsule (axis from y0 to y1 at x, z, radius r), or -1.
 * Tests the infinite vertical cylinder, then the end spheres.
 */
export function rayVerticalCapsule(
  o: Vec3,
  d: Vec3,
  x: number,
  z: number,
  y0: number,
  y1: number,
  r: number,
): number {
  let best = -1;
  const ox = o.x - x;
  const oz = o.z - z;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-12) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const y = o.y + d.y * t;
      if (t >= 0 && y >= y0 && y <= y1) best = t;
    }
  }
  for (const cy of [y0, y1]) {
    const t = raySphere(o, d, { x, y: cy, z }, r);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

export type Zone = 'head' | 'body' | 'limb';

/** Nearest hit on one standing character at `feet`, or null. */
export function hitCharacter(o: Vec3, d: Vec3, feet: Vec3): { t: number; zone: Zone } | null {
  const head = raySphere(
    o,
    d,
    { x: feet.x, y: feet.y + HITBOX.headY, z: feet.z },
    HITBOX.headRadius,
  );
  const body = rayVerticalCapsule(
    o,
    d,
    feet.x,
    feet.z,
    feet.y + HITBOX.bodyBottom + HITBOX.bodyRadius,
    feet.y + HITBOX.bodyTop - HITBOX.bodyRadius,
    HITBOX.bodyRadius,
  );
  if (head >= 0 && (body < 0 || head <= body + 0.05)) return { t: head, zone: 'head' };
  if (body >= 0) {
    // Low hits (below the hips) count as limbs.
    const y = o.y + d.y * body - feet.y;
    return { t: body, zone: y < 0.85 ? 'limb' : 'body' };
  }
  return null;
}

/** Unit direction from yaw (0 = +z) and pitch (positive = up). */
export function direction(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}
