/**
 * The Terms and Privacy Policy version players accept (decision D-23). Bump it when either
 * document changes: everyone is asked to accept again on their next login.
 */
export const TERMS_VERSION = '2026-11-06';
export const MIN_AGE = 18;

/** Whole years between `birth` (YYYY-MM-DD) and `today` (YYYY-MM-DD), by calendar date. */
export function ageOn(birth: string, today: string): number {
  const [by, bm, bd] = birth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** A real calendar date in YYYY-MM-DD between 1900-01-01 and `today`. */
export function isBirthDate(value: unknown, today: string): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value &&
    value >= '1900-01-01' &&
    value <= today
  );
}
