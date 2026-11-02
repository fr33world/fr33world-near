/**
 * Server-side movement validation (technical-plan §7.2). Each client simulates its own body and
 * reports poses; the server accepts a report only if the body could have got there legally:
 * within a speed budget, inside the city, at a sane height, and without passing through walls.
 *
 * Speed uses a distance budget that refills with real time instead of a per-message check, so
 * honest players whose reports arrive bunched up by network jitter are not rejected.
 */
import {
  type CollisionIndex,
  type HeightRange,
  interiorAt,
  isWalkable,
  type Rect,
} from '@fr33world/city';
import { MOVE_TOLERANCE, SPEED } from '@fr33world/shared';

export interface MoveLimits {
  maxSpeed: number;
  /** Collision radius used for the wall test (smaller than the real body, to give slack). */
  radius: number;
  /** How far below the ground and above the highest surface a body may report (m). */
  minY: number;
  maxY: number;
}

export const FOOT_LIMITS: MoveLimits = {
  maxSpeed: SPEED.RUN * MOVE_TOLERANCE,
  radius: 0.2,
  minY: -2,
  maxY: 6,
};

export const VEHICLE_LIMITS: MoveLimits = {
  maxSpeed: SPEED.VEHICLE_MAX * MOVE_TOLERANCE,
  radius: 0.5,
  minY: -2,
  maxY: 6,
};

/**
 * Most budget a body can bank: three seconds of top speed plus a metre of slack. A phone on
 * mobile data stalls for a second or two and then delivers the reports all at once; with one
 * second banked, a car at full speed (or someone running) was turned down after every stall
 * and pulled back.
 */
const BURST_SECONDS = 3;
const SLACK_METRES = 1;

export type MoveVerdict = 'ok' | 'speed' | 'bounds' | 'height' | 'wall';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export class MoveValidator {
  private budget = SLACK_METRES;
  private lastAt = 0;
  private readonly collision: CollisionIndex;
  private readonly bounds: Rect;
  private readonly heights: (x: number, z: number) => HeightRange;

  /** `heights`: the ground and the highest walkable surface at a point (city heightRange). */
  constructor(
    collision: CollisionIndex,
    bounds: Rect,
    heights: (x: number, z: number) => HeightRange,
  ) {
    this.collision = collision;
    this.bounds = bounds;
    this.heights = heights;
  }

  /** Call when the body is placed by the server (spawn, seat change, correction). */
  reset(now: number): void {
    this.budget = SLACK_METRES;
    this.lastAt = now;
  }

  check(from: Point3, to: Point3, limits: MoveLimits, now: number): MoveVerdict {
    const elapsed = Math.min(Math.max((now - this.lastAt) / 1000, 0), BURST_SECONDS);
    this.lastAt = now;
    this.budget = Math.min(
      this.budget + limits.maxSpeed * elapsed,
      limits.maxSpeed * BURST_SECONDS + SLACK_METRES,
    );

    // Rooms (interiors.ts) stand past the coast; only the server moves a body in or out.
    const room = interiorAt(to.x, to.z);
    if (room !== interiorAt(from.x, from.z)) return 'bounds';
    if (room) {
      if (to.y < limits.minY || to.y > room.height) return 'height';
    } else {
      const b = this.bounds;
      if (to.x < b.x0 || to.x > b.x1 || to.z < b.z0 || to.z > b.z1) return 'bounds';
      // The sea and the harbour: nobody walks or drives on water (the pier is fine).
      if (!isWalkable(to.x, to.z)) return 'bounds';
      const { ground, top } = this.heights(to.x, to.z);
      if (to.y < ground + limits.minY || to.y > top + limits.maxY) return 'height';
    }
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    if (dist > this.budget) return 'speed';
    // At its lower end: driving on a freeway deck passes over the pillars holding it up.
    const y = Math.min(from.y, to.y);
    if (this.collision.segmentBlocked(from.x, from.z, to.x, to.z, limits.radius, y)) return 'wall';
    this.budget -= dist;
    return 'ok';
  }
}
