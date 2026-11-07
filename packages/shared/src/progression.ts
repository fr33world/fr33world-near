/**
 * Levels and experience (PRD §9): every character starts at level 1; XP comes only from
 * validated activity (jobs, the tutorial, later faction work), each source capped per hour so
 * repeating a low-effort action can't farm levels. Each level takes a little more than the
 * last, so levels show progress without leaving new players far behind.
 */

export const MAX_LEVEL = 60;

/** XP to go from `level` to the next. */
export function xpToNext(level: number): number {
  return Math.round(100 + 40 * (level - 1) + 6 * (level - 1) ** 1.6);
}

/** The level a total of `xp` reaches, and how far into the next. */
export function levelOf(xp: number): { level: number; into: number; next: number } {
  let level = 1;
  let left = Math.max(0, Math.floor(xp));
  while (level < MAX_LEVEL && left >= xpToNext(level)) {
    left -= xpToNext(level);
    level += 1;
  }
  return { level, into: left, next: level < MAX_LEVEL ? xpToNext(level) : 0 };
}

/** Where XP may come from, and the most one character may take from each per hour. */
export const XP_SOURCES = {
  jobs: { perHour: 900, maxAward: 150 },
  tutorial: { perHour: 400, maxAward: 400 },
  /** Faction pay on duty (factions.ts SALARY). */
  faction: { perHour: 300, maxAward: 50 },
  /** Daily rewards (daily.ts). */
  daily: { perHour: 300, maxAward: 150 },
} as const;
export type XpSource = keyof typeof XP_SOURCES;

/** Titles shown with the level. */
export function titleOf(level: number): string {
  if (level >= 40) return 'Legend of Los Soles';
  if (level >= 25) return 'Local hero';
  if (level >= 15) return 'Regular';
  if (level >= 8) return 'Known face';
  if (level >= 3) return 'Settling in';
  return 'Newcomer';
}
