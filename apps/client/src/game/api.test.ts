import { describe, expect, it } from 'vitest';
import { formatMoney } from './api.ts';

describe('formatMoney', () => {
  it('shows whole dollars with separators, and cents only when present', () => {
    expect(formatMoney(500_000)).toBe('$5,000');
    expect(formatMoney(123_456_789)).toBe('$1,234,567.89');
    expect(formatMoney(0)).toBe('$0');
  });
});
