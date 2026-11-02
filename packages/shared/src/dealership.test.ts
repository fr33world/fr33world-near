import { describe, expect, it } from 'vitest';
import { CAR_MODELS, CIVILIAN_CARS } from './car-models.ts';
import { carPrice, CARS_FOR_SALE, DEALER_MODELS } from './dealership.ts';

describe('the dealership', () => {
  it('sells every everyday car once, cheapest first, and none of the service cars', () => {
    expect(DEALER_MODELS).not.toContain(-1);
    expect(new Set(DEALER_MODELS).size).toBe(CIVILIAN_CARS);
    for (const m of DEALER_MODELS) expect(m).toBeLessThan(CIVILIAN_CARS);
    const prices = CARS_FOR_SALE.map((c) => c.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    for (const p of prices) expect(Number.isSafeInteger(p) && p > 0).toBe(true);
  });

  it('prices models by index, and has no price for what it does not sell', () => {
    expect(carPrice(CAR_MODELS.findIndex((m) => m.id === 'sport'))).toBe(25_000_000);
    expect(carPrice(CAR_MODELS.findIndex((m) => m.id === 'police'))).toBeNull();
    expect(carPrice(-1)).toBeNull();
    expect(carPrice(99)).toBeNull();
  });
});
