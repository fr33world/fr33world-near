/**
 * Daily rewards (owner's launch-eve list), one readable file: a login streak, a free spin, three
 * tasks a day and a bonus for each level. They pay in-game `$`, XP and useful items only, from
 * their own capped faucet. Nothing here is ever USDC, and a spin is free: nothing is staked.
 * A day is a UTC day.
 */

export interface Prize {
  label: string;
  cents?: number;
  xp?: number;
  /** A CARE item put in the bag. */
  item?: 'bandage' | 'medicine';
}

/** The login streak: day 1 to 7, then round again. Miss a day and it starts over. */
export const LOGIN_STREAK: readonly Prize[] = [
  { label: '$100', cents: 10_000, xp: 10 },
  { label: '$150', cents: 15_000, xp: 15 },
  { label: 'Bandage', cents: 15_000, xp: 20, item: 'bandage' },
  { label: '$250', cents: 25_000, xp: 25 },
  { label: '$300', cents: 30_000, xp: 30 },
  { label: 'Medicine', cents: 30_000, xp: 40, item: 'medicine' },
  { label: '$1,000', cents: 100_000, xp: 100 },
];

/** The wheel, with how often each comes up (out of the total). */
export const SPIN: readonly (Prize & { weight: number })[] = [
  { label: '$50', cents: 5_000, weight: 30 },
  { label: '25 XP', xp: 25, weight: 22 },
  { label: '$100', cents: 10_000, weight: 18 },
  { label: 'Bandage', item: 'bandage', weight: 12 },
  { label: '$250', cents: 25_000, weight: 9 },
  { label: '75 XP', xp: 75, weight: 5 },
  { label: 'Medicine', item: 'medicine', weight: 3 },
  { label: '$1,000', cents: 100_000, weight: 1 },
];

export type TaskId = 'work' | 'earn' | 'shop';

export const DAILY_TASKS: readonly {
  id: TaskId;
  name: string;
  /** How much counts as done (job steps; cents from jobs; purchases). */
  need: number;
  prize: Prize;
}[] = [
  {
    id: 'work',
    name: 'Finish 3 job steps',
    need: 3,
    prize: { label: '$150', cents: 15_000, xp: 30 },
  },
  {
    id: 'earn',
    name: 'Earn $300 from jobs',
    need: 30_000,
    prize: { label: '$200', cents: 20_000, xp: 40 },
  },
  {
    id: 'shop',
    name: 'Buy something at Sunny’s',
    need: 1,
    prize: { label: '$100', cents: 10_000, xp: 20 },
  },
];

/** The bonus for reaching `level`: more each level, and an item every fifth. */
export function levelPrize(level: number): Prize {
  const cents = Math.min(level, 40) * 10_000;
  const item = level % 5 === 0 ? ('medicine' as const) : undefined;
  return { label: `$${cents / 100}${item ? ' + Medicine' : ''}`, cents, ...(item && { item }) };
}

/** The prize a roll in [0, total) lands on. */
export function spinPrize(roll: number): number {
  let left = roll;
  for (const [i, s] of SPIN.entries()) {
    left -= s.weight;
    if (left < 0) return i;
  }
  return 0;
}

export const SPIN_TOTAL = SPIN.reduce((n, s) => n + s.weight, 0);

/** The UTC day of a date, as `2026-11-07`: what keys a day's claims. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** The next day of the streak (1 to 7), given the last claim's day and streak. */
export function nextStreak(last: { day: string; streak: number } | null, today: string): number {
  if (!last) return 1;
  const gap = (Date.parse(today) - Date.parse(last.day)) / 86_400_000;
  if (gap !== 1) return 1;
  return (last.streak % LOGIN_STREAK.length) + 1;
}
