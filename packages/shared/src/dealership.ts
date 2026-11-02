/**
 * The dealership (Phase 7): Car Dealership on Sol Boulevard sells the everyday cars for `$`, the
 * money going into the purchases sink (economy.ts). Prices in cents, cheapest first, at about
 * what such a car would really cost (owner, 2026-11-02). Against the faucets: the $5,000
 * starter grant and two days' job pay at the cap ($8,000) buy the Compact before the free
 * rental runs out; the Sport is a month's steady work. The taxi, police cruiser and ambulance
 * aren't sold: they come with jobs and factions.
 */
import { CAR_MODELS } from './car-models.ts';

export const DEALER = {
  /** The most cars one account may own, the starter car included. */
  garageMax: 10,
} as const;

/**
 * A newcomer's car (owner, 2026-10-31): every account gets the cheapest car on rent from Sol
 * Motors, free, for its first days, to get about and earn the money for one of its own. Then it
 * goes back. Once per account.
 */
export const RENTAL = { model: 'compact', days: 3 } as const;

/** How long a rental has left, in words ("2 days 5 h", "40 min"), from milliseconds. */
export function rentalLeft(ms: number): string {
  if (ms <= 0) return 'due back now';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)} day${h >= 48 ? 's' : ''} ${h % 24} h`;
  if (h >= 1) return `${h} h ${Math.floor((ms % 3_600_000) / 60_000)} min`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

export const CARS_FOR_SALE: readonly { id: string; price: number }[] = [
  { id: 'compact', price: 1_800_000 },
  { id: 'hatchback', price: 2_400_000 },
  { id: 'sedan', price: 3_500_000 },
  { id: 'wagon', price: 3_800_000 },
  { id: 'minivan', price: 4_200_000 },
  { id: 'pickup', price: 5_500_000 },
  { id: 'offroad', price: 6_800_000 },
  { id: 'suv', price: 8_500_000 },
  { id: 'coupe', price: 12_000_000 },
  { id: 'sport', price: 25_000_000 },
];

/** A car model's price (index into CAR_MODELS), or null when the dealership doesn't sell it. */
export function carPrice(model: number): number | null {
  const id = CAR_MODELS[model]?.id;
  return CARS_FOR_SALE.find((c) => c.id === id)?.price ?? null;
}

/** The models for sale, as indices into CAR_MODELS, in the catalogue's order. */
export const DEALER_MODELS: readonly number[] = CARS_FOR_SALE.map((c) =>
  CAR_MODELS.findIndex((m) => m.id === c.id),
);

/**
 * The car market between players (Phase 11): prices between a share of the dealer's and a
 * multiple of it, a fee to the game, a cooling-off before a bought car can be sold again, and
 * a few listings each. Full accounts only (like payments): guests can't sell or buy.
 */
export const MARKET = {
  floorShare: 0.4,
  ceilingShare: 2,
  feeShare: 0.05,
  resellHours: 24,
  maxListings: 3,
} as const;
