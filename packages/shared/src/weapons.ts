/**
 * Weapon stats, shared so the client's feedback matches what the server decides. In-game
 * names avoid trademarks (technical-plan §9).
 */
export interface WeaponStats {
  name: string;
  /** Damage by hit zone. */
  body: number;
  head: number;
  limb: number;
  /** Minimum time between shots (ms). */
  intervalMs: number;
  /** Effective range (m). */
  range: number;
  magazine: number;
}

export const WEAPONS: Record<number, WeaponStats> = {
  1: {
    name: '.50 Heavy Pistol',
    body: 34,
    head: 80,
    limb: 22,
    intervalMs: 280,
    range: 60,
    magazine: 7,
  },
  2: {
    name: 'Assault Rifle',
    body: 24,
    head: 60,
    limb: 16,
    intervalMs: 100,
    range: 120,
    magazine: 30,
  },
  // Bare hands (the punch; no stance to take out): arm's reach, weak, about two a second.
  3: {
    name: 'Fists',
    body: 9,
    head: 14,
    limb: 6,
    intervalMs: 520,
    range: 1.7,
    magazine: 0,
  },
};

export const MAX_HP = 100;
/** Seconds a downed player waits for a medic before respawning. */
export const DOWNED_SECONDS = 30;
/** How far from the shooter's validated position a reported muzzle may be (m). */
export const MUZZLE_TOLERANCE = 2.5;
/** Shooter eye/chest height used for origins (m above the feet). */
export const SHOOT_HEIGHT = 1.45;

/** Hitbox of a standing character relative to its feet. */
export const HITBOX = {
  bodyBottom: 0.15,
  bodyTop: 1.42,
  bodyRadius: 0.3,
  headY: 1.62,
  headRadius: 0.15,
} as const;
