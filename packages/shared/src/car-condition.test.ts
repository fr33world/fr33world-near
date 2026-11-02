import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crashDamage, DAMAGE, enginePower, FUEL, fuelCost, repairCost } from './car-condition.ts';

// Damage is off for launch; these check it as it'll be when it's back.
const flags = DAMAGE as { enabled: boolean };
let was = false;
beforeEach(() => {
  was = flags.enabled;
  flags.enabled = true;
});
afterEach(() => {
  flags.enabled = was;
});

describe('car condition', () => {
  it('does nothing while damage is off', () => {
    flags.enabled = false;
    expect(crashDamage(30, 0, 0.05)).toBe(0);
  });

  it('counts a crash only past the hardest braking', () => {
    // Braking from 20 m/s to 19.5 in 50 ms: nothing. Into a wall at 50 km/h: about a third.
    expect(crashDamage(20, 19.5, 0.05)).toBe(0);
    expect(crashDamage(14, 0, 0.05)).toBeCloseTo((14 - 0.55 - DAMAGE.slack) * DAMAGE.perMs, 6);
    expect(crashDamage(14, 0, 0.05)).toBeGreaterThan(0.3);
    expect(crashDamage(5, 0, 0.05)).toBeCloseTo((5 - 3.55) * DAMAGE.perMs, 6);
    // Speeding up is never damage.
    expect(crashDamage(0, 20, 0.05)).toBe(0);
  });

  it('prices fuel and repairs by what is missing, with a floor and nothing when full', () => {
    expect(fuelCost(1)).toBe(0);
    expect(fuelCost(0.99)).toBe(0);
    expect(fuelCost(0)).toBe(FUEL.fullTank);
    expect(fuelCost(0.5)).toBe(FUEL.fullTank / 2);
    expect(fuelCost(0.97)).toBe(180);
    expect(repairCost(0)).toBe(DAMAGE.fullRepair);
    expect(repairCost(0.975)).toBe(1_000);
    expect(repairCost(1)).toBe(0);
  });

  it('takes power away as the car wears, and all of it empty or wrecked', () => {
    expect(enginePower(1, 1)).toBe(1);
    expect(enginePower(0.5, 0.5)).toBeCloseTo(0.725);
    expect(enginePower(0, 1)).toBe(0);
    expect(enginePower(1, 0)).toBe(0);
  });
});
