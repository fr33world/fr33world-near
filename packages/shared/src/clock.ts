/**
 * The server-wide game clock (decision D-18). The world server owns an anchor and a rate and
 * sends them on connect; every client computes the same time from its synced server time, so
 * the clock costs no per-tick traffic.
 */

/** Default rate: one in-game day per 48 real minutes, as in GTA Online. */
export const DEFAULT_CLOCK_RATE = 30;
export const MINUTES_PER_DAY = 1440;

export interface ClockAnchor {
  /**
   * The moment `gameMinutes` held, in ms on the receiver's timeline: wall-clock time on the
   * server, server time (`NetClient.serverNow`) in what the server sends, so a client's own
   * clock being wrong doesn't move the sun.
   */
  realMs: number;
  /** Game minutes since day 0, 00:00 at that moment. */
  gameMinutes: number;
  /** Game minutes that pass per real minute. 0 freezes the clock. */
  rate: number;
}

/**
 * Game time is a pure function of the wall clock from this anchor, so the time of day carries
 * on across server restarts (a sleeping free-plan server wakes at the right hour) and a client
 * that can't reach the server still shows the city's real time.
 */
export const CLOCK_EPOCH: ClockAnchor = {
  realMs: Date.UTC(2026, 9, 1),
  gameMinutes: 8 * 60,
  rate: DEFAULT_CLOCK_RATE,
};

export function gameMinutesAt(anchor: ClockAnchor, realMs: number): number {
  return anchor.gameMinutes + ((realMs - anchor.realMs) / 60_000) * anchor.rate;
}

/** Hours since midnight in [0, 24), fractional. */
export function hourOfDay(gameMinutes: number): number {
  const m = ((gameMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return m / 60;
}

/** "07:45" style label for the HUD. */
export function formatClock(gameMinutes: number): string {
  const h = hourOfDay(gameMinutes);
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Re-anchors the clock at `realMs`, e.g. when an admin changes the rate, so the time of day
 * never jumps.
 */
export function reanchor(anchor: ClockAnchor, realMs: number, rate: number): ClockAnchor {
  return { realMs, gameMinutes: gameMinutesAt(anchor, realMs), rate };
}
