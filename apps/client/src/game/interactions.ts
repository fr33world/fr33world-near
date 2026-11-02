/**
 * The interaction-prompt framework (Phase 4): one system for everything a player can use:
 * cars now, the info kiosk, and later doors, NPCs and job points. Each system adds a source
 * that offers what is in reach; every frame the best offer becomes the prompt (the nearest,
 * favouring what the player faces), shown as one marker over it (E on a keyboard, a tap on
 * touch) and on the touch action button. An offer may ask to be held (a progress ring) rather
 * than pressed.
 */

export type InteractionIcon = 'car' | 'exit' | 'info' | 'door' | 'talk' | 'job' | 'sit';

export interface Interaction {
  /** Stable while it's the same thing (e.g. "car:12"), so a hold isn't reset by a new frame. */
  key: string;
  label: string;
  icon: InteractionIcon;
  /** Where its marker floats; none = no marker (e.g. getting out of the car you drive). */
  at?: { x: number; y: number; z: number };
  /** Horizontal distance from the player (m), for picking the best. */
  distance: number;
  /** Hold this long (ms) to do it; 0 or none = a press. */
  holdMs?: number;
  run(): void;
}

/** Where the player is and faces (yaw: 0 = +z), for sources to offer from. */
export interface Reach {
  x: number;
  y: number;
  z: number;
  yaw: number;
  driving: boolean;
}

export type InteractionSource = (reach: Reach) => Interaction | Interaction[] | null;

/** How much (m) facing away from an offer counts against it, at worst. */
const FACING_WEIGHT = 1.5;

export class Interactions {
  private readonly sources = new Set<InteractionSource>();
  /** The prompt now, and how far through its hold (0–1). */
  current: Interaction | null = null;
  progress = 0;
  private holdFrom: number | null = null;
  /** After a hold completes, the key must be let go before another starts. */
  private latched = false;

  /** Adds a source; returns the function that removes it. */
  add(source: InteractionSource): () => void {
    this.sources.add(source);
    return () => this.sources.delete(source);
  }

  /** The best offer for `reach` (exported for tests). */
  pick(reach: Reach): Interaction | null {
    const fx = Math.sin(reach.yaw);
    const fz = Math.cos(reach.yaw);
    let best: Interaction | null = null;
    let bestScore = Infinity;
    for (const source of this.sources) {
      const offered = source(reach);
      if (!offered) continue;
      for (const o of Array.isArray(offered) ? offered : [offered]) {
        let score = o.distance;
        if (o.at && o.distance > 0.3) {
          const dot = ((o.at.x - reach.x) * fx + (o.at.z - reach.z) * fz) / o.distance;
          score += ((1 - dot) / 2) * FACING_WEIGHT;
        }
        if (score < bestScore) {
          best = o;
          bestScore = score;
        }
      }
    }
    return best;
  }

  /**
   * Once a frame: picks the prompt and acts on the input (`pressed` this frame, `held` now).
   * Returns the interaction done this frame, if any.
   */
  update(reach: Reach, pressed: boolean, held: boolean, now: number): Interaction | null {
    const best = this.pick(reach);
    if (best?.key !== this.current?.key) {
      this.holdFrom = null;
      this.progress = 0;
    }
    this.current = best;
    if (!held) this.latched = false;
    if (!best) return null;
    const hold = best.holdMs ?? 0;
    if (hold <= 0) {
      if (!pressed) return null;
      best.run();
      return best;
    }
    if (!held || this.latched) {
      this.holdFrom = null;
      this.progress = 0;
      return null;
    }
    this.holdFrom ??= now;
    this.progress = Math.min(1, (now - this.holdFrom) / hold);
    if (this.progress < 1) return null;
    this.latched = true;
    this.holdFrom = null;
    this.progress = 0;
    best.run();
    return best;
  }
}
