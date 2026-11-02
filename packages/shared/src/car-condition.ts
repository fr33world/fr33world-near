/**
 * Fuel and damage (Phase 7). The world server keeps both for every car: fuel burns by the
 * distance driven, damage comes from crashes (speed lost faster than the hardest braking can
 * shed it). A damaged car loses power and smokes; at zero it's wrecked and won't go. Both are
 * put right at a car park's attendant, for money into the purchases sink; a player's own car
 * keeps its fuel and condition in the garage.
 */

export const FUEL = {
  /** How far a full tank goes (m). */
  range: 24_000,
  /** A full tank, in cents; part tanks cost their share. */
  fullTank: 6_000,
  /** The dashboard warns below this. */
  low: 0.15,
} as const;

export const DAMAGE = {
  /**
   * Off for launch (owner, 2026-10-31: crashes wearing cars down isn't good enough yet): cars
   * take no damage and stay like new. The rest of this stays for when it's back (track.md,
   * After launch).
   */
  enabled: false,
  /** The hardest a car slows by braking (m/s²), and slack for bumps between reports (m/s). */
  brakeDecel: 11,
  slack: 3,
  /** Condition lost per m/s of speed lost beyond braking (a 50 km/h wall: about a third). */
  perMs: 0.035,
  /** Smoke below this condition. */
  smokeBelow: 0.45,
  /** A full repair, in cents; part repairs cost their share. */
  fullRepair: 40_000,
} as const;

/** The smallest charge for fuel or a repair (cents). */
export const MIN_SERVICE = 100;

/** Condition lost when a car's speed fell from `before` to `after` (m/s) in `dt` seconds. */
export function crashDamage(before: number, after: number, dt: number): number {
  if (!DAMAGE.enabled) return 0;
  const lost = before - after - (DAMAGE.brakeDecel * Math.max(0, dt) + DAMAGE.slack);
  return lost > 0 ? lost * DAMAGE.perMs : 0;
}

/** What topping up costs at `fuel` (0–1), or 0 when it's (nearly) full. */
export function fuelCost(fuel: number): number {
  const missing = 1 - Math.max(0, Math.min(1, fuel));
  return missing < 0.02 ? 0 : Math.max(MIN_SERVICE, Math.ceil(missing * FUEL.fullTank - 1e-6));
}

/** What a repair costs at `health` (0–1), or 0 when there's nothing to fix. */
export function repairCost(health: number): number {
  const missing = 1 - Math.max(0, Math.min(1, health));
  return missing < 0.02 ? 0 : Math.max(MIN_SERVICE, Math.ceil(missing * DAMAGE.fullRepair - 1e-6));
}

/** The engine's share of its power: none when empty or wrecked, less the worse its condition. */
export function enginePower(fuel: number, health: number): number {
  if (fuel <= 0 || health <= 0) return 0;
  return 0.45 + 0.55 * Math.min(1, health);
}
