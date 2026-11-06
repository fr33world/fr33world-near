/**
 * Weapons as things players own (Phase 8). The world server checks every shot against what
 * the shooter owns: the weapon in hand, rounds in its magazine, not mid-reload. Weapons and
 * rounds are bought (`$` into the purchases sink): the pistol at the Gun Store with a licence (from
 * level 5), the rifle from the black-market dealer, for gang members of rank (Phase 9).
 */
import { GOODS } from './business.ts';

export interface ArmoryItem {
  id: string;
  name: string;
  /** Cents. */
  price: number;
  /** The weapon it is (protocol WEAPON), or the weapon its rounds are for, and how many. */
  weapon: number;
  rounds?: number;
  /** Where it's sold: the gun store (licence needed), or the black market (a gang rank). */
  where: 'store' | 'black_market';
}

export const ARMORY = {
  /** The pistol licence: from this level, for this much. */
  licence: { price: 250_000, minLevel: 5 },
  /** The most rounds of each weapon a player may carry. */
  maxRounds: { 1: 140, 2: 300 } as Record<number, number>,
  /** How long a reload takes (ms). */
  reloadMs: { 1: 1_600, 2: 2_400 } as Record<number, number>,
  /** The lowest gang rank (Phase 9 ranks, 1 = newest) the black market sells the rifle to. */
  blackMarketRank: 2,
  items: [
    { id: 'pistol', name: '.50 Heavy Pistol', price: 350_000, weapon: 1, where: 'store' },
    {
      id: 'pistol_rounds',
      name: '.50 rounds ×28',
      price: 5_600,
      weapon: 1,
      rounds: 28,
      where: 'store',
    },
    { id: 'rifle', name: 'Assault Rifle', price: 1_200_000, weapon: 2, where: 'black_market' },
    {
      id: 'rifle_rounds',
      name: 'Rifle rounds ×90',
      price: 18_000,
      weapon: 2,
      rounds: 90,
      where: 'black_market',
    },
  ] satisfies ArmoryItem[] as ArmoryItem[],
} as const;

/** What a player has: the licence, the weapons they own, and their rounds for each. */
export interface Arms {
  licence: boolean;
  weapons: number[];
  rounds: Record<number, number>;
  /** Medicine and bandages (CARE items by id). */
  care?: Record<string, number>;
}

export const NO_ARMS: Arms = { licence: false, weapons: [], rounds: {} };

/** The Hospital, in the Medical Center: waking there after going down costs this. */
export const HOSPITAL_FEE = 10_000;

/** Going down and getting better (owner, 2026-10-31). */
export const MEDICAL = {
  /** Having called EMS, how long you wait for them before you faint anyway (ms). */
  emsWaitMs: 120_000,
  /** A hospital bed: you wake with this much health and reach full in this long. */
  bedStartHp: 20,
  bedMs: 75_000,
} as const;

/** The Hospital's counter (owner, 2026-10-31): what it sells, and how it's sold. */
export const CARE = {
  items: [
    { id: 'bandage', name: 'Bandage', price: 6_000, heal: 25, clip: 'bandaging' },
    { id: 'medicine', name: 'Medicine', price: 15_000, heal: 60, clip: 'medicine' },
  ],
  /** With no EMS on duty in the building it's self-service, at this many times the price. */
  selfServe: 1.5,
  /** The share of a sale paid to the EMS worker in the building. */
  commission: 0.3,
  /** The most of each a player can carry. */
  max: 5,
  /** Hit this recently (ms), you can't use one: no patching up mid-fight. */
  noUseAfterHitMs: 10_000,
} as const;

/** Everything the bag can hold and use: the Hospital's items, then Sunny's goods. */
export const CONSUMABLES: readonly { id: string; name: string; heal: number; clip: string }[] = [
  ...CARE.items,
  ...GOODS.map((g) => ({ id: g.id, name: g.name, heal: g.heal, clip: 'medicine' })),
];

/** What a CARE item costs. */
export function carePrice(cents: number, staffed: boolean): number {
  return staffed ? cents : Math.round(cents * CARE.selfServe);
}

/** Falling out of a moving car (owner, 2026-10-31). */
export const FALL = {
  /** Slower than this (m/s, 20 km/h) you just step out. */
  minSpeed: 5.5,
  /** How long you stay down, how fast the fall plays, how long getting up takes (ms). */
  downMs: 3_200,
  fallRate: 1.7,
  getUpMs: 1_800,
  /** Health lost: least at minSpeed, most from fullSpeed (m/s) up. It never kills. */
  minDamage: 5,
  maxDamage: 45,
  fullSpeed: 33,
  lowestHp: 5,
} as const;

/** The health a fall at `speed` (m/s) costs. */
export function fallDamage(speed: number): number {
  if (speed < FALL.minSpeed) return 0;
  const t = Math.min(1, (speed - FALL.minSpeed) / (FALL.fullSpeed - FALL.minSpeed));
  return Math.round(FALL.minDamage + t * (FALL.maxDamage - FALL.minDamage));
}
