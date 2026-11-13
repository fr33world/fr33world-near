/**
 * What players own on NEAR, and the one way real money comes into `$` (owner, 2026-11-13).
 *
 * `$` is the play money, like any city game's: the game sells everything for it (cars, fuel,
 * food, fines) and it never turns into USDC. What a player buys to keep is an asset: each car
 * bought at the dealership is minted to the buyer's own NEAR wallet (contracts/cars), its
 * title deed, theirs even if the game later bans them. Players may sell their cars to each
 * other for `$` (the market, as before) or for USDC through the cars contract: the buyer
 * chooses, the seller is paid directly, and the dealership's wallet gets its cut. The game
 * itself sells nothing for USDC except `$` top-ups, one way, whose USDC goes to the dealership.
 *
 * USDC amounts are micro-USDC (6 decimals): 1_000_000 is 1 USDC.
 */
import { CAR_MODELS } from './car-models.ts';
import { carPrice } from './dealership.ts';
import { USDC } from './business.ts';

/** The dealership's own NEAR account and wallet contract (contracts/business-wallet). */
export const DEALERSHIP = {
  id: 'dealer',
  /** The part before `.fr33world.testnet`. */
  account: 'sol-motors',
  name: 'Sol Motors',
  /** Wallet limits, in micro-USDC: the most one buyback, and the most in a day. */
  perPayment: 25 * USDC,
  perDay: 100 * USDC,
} as const;

/** The cars contract, and what it enforces (contracts/cars). */
export const CAR_ASSETS = {
  /** The part before `.fr33world.testnet`. */
  account: 'cars',
  /** The dealership's cut of every USDC sale between players, in basis points (5%). */
  feeBps: 500,
  /**
   * How long a new or newly sold car can't be sent or listed, so farming cars to cash them out
   * at once doesn't pay. Testnet is short so the market can be tried; mainnet is a day.
   */
  lockHours: { testnet: 1, mainnet: 24 },
  /** USDC listing prices, micro-USDC. The contract refuses under 1 USDC. */
  minPrice: 1 * USDC,
  maxPrice: 100_000 * USDC,
  /** Open USDC listings per player, and USDC car sales one player may make in a day. */
  maxListings: 3,
  salesPerDay: 3,
  /** Where a car's picture is, for its title deed in wallets. */
  mediaBase: 'https://fr33worldgame.xyz/ui/cars/',
} as const;

/** Real money into play money, one way: never `$` back to USDC (owner, 2026-11-13). */
export const TOPUP = {
  /** `$` (whole dollars) for each USDC. */
  dollarsPerUsdc: 5_000,
  /** Smallest top-up, and the most one account may top up in seven days. */
  min: 1 * USDC,
  perWeek: 50 * USDC,
  /** How long a prepared top-up waits for its signature. */
  minutes: 10,
} as const;

/** The `$` (cents) a top-up of `micro` USDC buys. */
export function topupCents(micro: number): number {
  return Math.floor((micro * TOPUP.dollarsPerUsdc * 100) / USDC);
}

/** What a car is worth in USDC at the top-up rate: its dealer price, or null if not sold. */
export function fairUsdc(model: number): number | null {
  const cents = carPrice(model);
  return cents === null ? null : Math.round((cents / 100 / TOPUP.dollarsPerUsdc) * USDC);
}

/**
 * A car's token id on the cars contract: its id and a random tag, so cars from different
 * databases (the live game, test runs) can never share one on the same contract.
 */
export const carToken = (carId: number | string, tag: string) => `car-${carId}-${tag}`;

/** A car's title on chain and in wallets: "Sport #13". */
export const carTitle = (model: number, carId: number) =>
  `${CAR_MODELS[model]?.name ?? 'Car'} #${carId}`;
