import { describe, expect, it } from 'vitest';
import { DEFAULT_CLOCK_RATE, formatClock, gameMinutesAt, hourOfDay, reanchor } from './clock.ts';

describe('game clock', () => {
  const anchor = { realMs: 1_000_000, gameMinutes: 8 * 60, rate: DEFAULT_CLOCK_RATE };

  it('runs a full day in 48 real minutes at the default rate', () => {
    const later = gameMinutesAt(anchor, anchor.realMs + 48 * 60_000);
    expect(later - anchor.gameMinutes).toBe(1440);
    expect(hourOfDay(later)).toBe(8);
  });

  it('formats the time of day and wraps past midnight', () => {
    expect(formatClock(8 * 60 + 5)).toBe('08:05');
    expect(formatClock(1440 + 23 * 60 + 59.9)).toBe('23:59');
    expect(formatClock(-30)).toBe('23:30');
  });

  it('keeps the time when the rate changes', () => {
    const at = anchor.realMs + 10 * 60_000;
    const next = reanchor(anchor, at, 0);
    expect(next.gameMinutes).toBe(gameMinutesAt(anchor, at));
    expect(gameMinutesAt(next, at + 60_000)).toBe(next.gameMinutes);
  });
});
