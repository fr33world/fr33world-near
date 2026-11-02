import { describe, expect, it } from 'vitest';
import { ageOn, isBirthDate } from './legal.ts';

describe('ageOn', () => {
  it('counts whole years by calendar date', () => {
    expect(ageOn('2008-10-28', '2026-10-28')).toBe(18);
    expect(ageOn('2008-10-29', '2026-10-28')).toBe(17);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(ageOn('2008-02-29', '2026-03-01')).toBe(18);
  });
});

describe('isBirthDate', () => {
  it('accepts real past dates only', () => {
    expect(isBirthDate('1995-06-15', '2026-10-28')).toBe(true);
    expect(isBirthDate('1995-02-30', '2026-10-28')).toBe(false);
    expect(isBirthDate('2027-01-01', '2026-10-28')).toBe(false);
    expect(isBirthDate('1899-12-31', '2026-10-28')).toBe(false);
    expect(isBirthDate(19950615, '2026-10-28')).toBe(false);
  });
});
