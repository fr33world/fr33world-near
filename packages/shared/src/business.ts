/**
 * The businesses of Los Soles and the rules they run by, in one readable file (D-42, D-43).
 *
 * Each business has its own NEAR account and wallet contract (contracts/business-wallet). They
 * start with stock and no money: USDC only ever arrives from players' purchases, moves down the
 * supply chain as supplier payments, and comes back to players as pay for delivery jobs. The
 * rules here are plain arithmetic, the same every run. An AI may only suggest changes to
 * `markup` and `target` inside the limits below, and the wallet contract has the last word.
 *
 * USDC amounts are micro-USDC (6 decimals): 1_000_000 is 1 USDC.
 */

export const USDC = 1_000_000;

export type GoodId = 'water' | 'sandwich' | 'meal';

export interface Good {
  id: GoodId;
  name: string;
  /** What a player pays in `$` (cents) at Sunny's. */
  cents: number;
  /** What it costs at the Farm's gate, in micro-USDC; prices rise from this down the chain. */
  cost: number;
  /** Health a player gets back from it. */
  heal: number;
}

export const GOODS: readonly Good[] = [
  { id: 'water', name: 'Water', cents: 300, cost: 20_000, heal: 5 },
  { id: 'sandwich', name: 'Sandwich', cents: 900, cost: 60_000, heal: 15 },
  { id: 'meal', name: 'Hot Meal', cents: 2_500, cost: 150_000, heal: 60 },
];

export type BusinessId = 'farm' | 'wholesale' | 'market';

export interface Business {
  id: BusinessId;
  /** The part before `.fr33world.testnet`. */
  account: string;
  name: string;
  /** Who it buys from (null: it grows its own). */
  supplier: BusinessId | null;
  /** Added to what it pays, as a share (0.25 is 25%). */
  markup: number;
  /** Stock of each good it tries to hold, and the stock it starts with. */
  target: number;
  /** Reorder when stock falls to this share of the target. */
  reorderAt: number;
  /** The wallet contract's limits, in micro-USDC. */
  perPayment: number;
  perDay: number;
}

export const BUSINESSES: readonly Business[] = [
  {
    id: 'farm',
    account: 'sol-farm',
    name: 'Sol Valley Farm',
    supplier: null,
    markup: 0,
    target: 400,
    reorderAt: 0.5,
    perPayment: 5 * USDC,
    perDay: 25 * USDC,
  },
  {
    id: 'wholesale',
    account: 'harbor-wholesale',
    name: 'Harbor Wholesale',
    supplier: 'farm',
    markup: 0.15,
    target: 200,
    reorderAt: 0.4,
    perPayment: 10 * USDC,
    perDay: 40 * USDC,
  },
  {
    id: 'market',
    account: 'sunnys-grocery',
    name: "Sunny's Grocery",
    supplier: 'wholesale',
    markup: 0.3,
    target: 60,
    reorderAt: 0.35,
    perPayment: 10 * USDC,
    perDay: 40 * USDC,
  },
];

/**
 * Keeps the shelves from going bare for `$` shoppers, with no USDC involved: a small local
 * supplier brings this many of each `$` good per tick, up to this share of the target. USDC
 * can't be made from `$`, so this stock costs the businesses nothing and earns them nothing.
 */
export const LOCAL_SUPPLY = { perTick: 6, upTo: 0.5 } as const;

/** What an AI may change, and how far from the rules above. */
export const AI_LIMITS = {
  /** The most a markup can move in one decision, and its floor and ceiling. */
  markupStep: 0.05,
  markupMin: 0.05,
  markupMax: 0.6,
  /** The most a stock target can move in one decision, as a share. */
  targetStep: 0.2,
} as const;

/** Delivery jobs: how businesses hand USDC back to players for carrying their orders. */
export const JOB_RULES = {
  /** A delivery job pays this share of the order it carries, within these bounds. */
  payShare: 0.08,
  minPay: 20_000,
  maxPay: 1 * USDC,
  /** Spend at most this share of free money on stock: the rest pays the people who carry it. */
  restockShare: 0.8,
  /** Offer a job only if its pay is within this share of what's free. */
  keepFree: 0.5,
  /** Open jobs a business has at once. */
  maxOpen: 3,
  /** Who may take one: USDC work isn't for throwaway accounts (shared PAYMENTS' reasoning). */
  minLevel: 3,
  minCharacterAgeHours: 24,
  /** Most USDC jobs one player is paid for in a day. */
  perPlayerPerDay: 5,
  /** A job taken and not finished in this long goes back, and the van brings the goods. */
  takenForMs: 3_600_000,
  /** Payment attempts before an order is given up and its goods go back to the seller. */
  maxAttempts: 6,
} as const;

/** What one unit of `good` costs from `seller`, in micro-USDC. */
export function unitPrice(seller: Business, good: Good, all = BUSINESSES): number {
  const upstream = seller.supplier ? all.find((b) => b.id === seller.supplier) : null;
  const base = upstream ? unitPrice(upstream, good, all) : good.cost;
  return Math.round(base * (1 + seller.markup));
}

/** How many of a good to order: back up to the target, once stock falls to the reorder level. */
export function reorderQuantity(b: Business, stock: number): number {
  return stock <= Math.floor(b.target * b.reorderAt) ? b.target - stock : 0;
}

/** Trims an order to what the wallet can pay: free money and the per-payment limit. */
export function affordable(quantity: number, price: number, free: number, limit: number): number {
  if (price <= 0) return 0;
  return Math.max(0, Math.min(quantity, Math.floor(Math.min(free, limit) / price)));
}

/** A delivery job's pay for an order worth `orderValue`. */
export function jobPay(orderValue: number): number {
  return Math.min(
    JOB_RULES.maxPay,
    Math.max(JOB_RULES.minPay, Math.round(orderValue * JOB_RULES.payShare)),
  );
}

/** An AI's suggestion cut back to what the limits allow. */
export function clampProposal(
  b: Business,
  p: { markup?: unknown; target?: unknown },
): { markup: number; target: number } {
  const n = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const markup = clamp(
    clamp(n(p.markup, b.markup), b.markup - AI_LIMITS.markupStep, b.markup + AI_LIMITS.markupStep),
    AI_LIMITS.markupMin,
    AI_LIMITS.markupMax,
  );
  const step = b.target * AI_LIMITS.targetStep;
  return {
    markup: Math.round(markup * 1000) / 1000,
    target: Math.round(clamp(n(p.target, b.target), b.target - step, b.target + step)),
  };
}

/** How long an order waits for a player to carry it before the business's own van does. */
export const VAN_AFTER_MS = 6 * 3_600_000;

/** USDC for people: 1_250_000 is "1.25 USDC". */
export function formatUsdc(micro: number): string {
  return `${(micro / USDC).toFixed(micro % 10_000 === 0 ? 2 : 4)} USDC`;
}

/**
 * Test USDC for players, testnet only: the wallet's "Get test USDC" asks the public community
 * faucet (v2.faucet.nonofficial.testnet) to send it straight to the player's own NEAR account.
 * The game adds no USDC of its own. The limits keep one person from draining the faucet or the
 * operator's gas: a claim is small, at most once a day for each game account and each wallet,
 * only while the wallet is nearly empty, and capped across everyone.
 */
export const TEST_USDC = {
  /** One claim: enough for about twenty Hot Meals. */
  micro: 5 * USDC,
  /** Hours between claims, for the same game account or the same NEAR wallet. */
  everyHours: 24,
  /** A wallet holding this much or more can't claim. */
  holdingBelow: 5 * USDC,
  /** Claims a day across all players. */
  perDay: 100,
} as const;
