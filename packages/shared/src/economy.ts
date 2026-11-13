/**
 * The economy's taps and drains (technical-plan §7, D-24), in cents. `$` is created only by a
 * faucet the server pays from, never by a client, and each faucet caps what one character can
 * take from it in an hour and in a day. It leaves only into a sink. These numbers are the
 * starting point; the economy simulator (apps/api) checks them before launch.
 */

export interface Faucet {
  /** The ledger's system account it pays from. */
  account: string;
  about: string;
  /** Largest single payment, and the most one character may take per hour and per day. */
  maxPayment: number;
  perHour: number;
  perDay: number;
}

export interface Sink {
  account: string;
  about: string;
}

export const FAUCETS = {
  /** Once per account, on finishing onboarding (keyed by the account). */
  signup: {
    account: 'faucet:signup',
    about: 'Starter grant',
    maxPayment: 500_000,
    perHour: 500_000,
    perDay: 500_000,
  },
  tutorial: {
    account: 'faucet:tutorial',
    about: 'Tutorial rewards',
    maxPayment: 50_000,
    perHour: 100_000,
    perDay: 100_000,
  },
  /**
   * Courier, mining, taxi: computed by the server per delivery, ore or fare. One payment can
   * be a whole bag of gold ore ($840): at $500 a bag over that was turned down (2026-10-30).
   */
  jobs: {
    account: 'faucet:jobs',
    about: 'Job pay',
    maxPayment: 100_000,
    perHour: 150_000,
    perDay: 800_000,
  },
  /** The login streak, the free spin, daily tasks and level bonuses (daily.ts). */
  daily: {
    account: 'faucet:daily',
    about: 'Daily rewards',
    maxPayment: 400_000,
    perHour: 500_000,
    perDay: 800_000,
  },
  /**
   * `$` bought with USDC (shared TOPUP): the USDC went to the dealership's wallet on chain
   * first. One top-up can be a whole week's allowance.
   */
  topup: {
    account: 'faucet:topup',
    about: 'USDC top-up',
    maxPayment: 25_000_000,
    perHour: 25_000_000,
    perDay: 25_000_000,
  },
  /** Faction pay for each 10 minutes on duty (D-26). */
  salary: {
    account: 'faucet:salary',
    about: 'Faction salary',
    maxPayment: 30_000,
    perHour: 120_000,
    perDay: 600_000,
  },
} as const satisfies Record<string, Faucet>;

export const SINKS = {
  /** Hospital, licences, fines, trade fees. */
  fees: { account: 'sink:fees', about: 'Fees' },
  /** Cars, fuel, repairs, ammunition, clothes: what the game sells. */
  purchases: { account: 'sink:purchases', about: 'Purchases' },
} as const satisfies Record<string, Sink>;

export type FaucetName = keyof typeof FAUCETS;
export type SinkName = keyof typeof SINKS;

/** Player-to-player payments: bounded, rate-limited and logged (technical-plan §7). */
export const PAYMENTS = {
  /** Smallest and largest single payment. */
  min: 100,
  max: 2_500_000,
  /** At most this many payments sent per hour, and this much in a day. */
  perHour: 10,
  perDay: 10_000_000,
  /**
   * Only full (not guest) accounts whose character is this old may send, so starter grants
   * farmed on throwaway accounts can't be funnelled into one (the fan-in flag catches the rest).
   */
  minCharacterAgeHours: 24,
  /** Longest note with a payment. */
  noteChars: 80,
} as const;

/** When the anomaly scan (apps/api anomalies.ts) flags an account for review. */
export const ANOMALY = {
  /** Earned from faucets in an hour: more than every faucet's hourly cap together is a bug. */
  earnedPerHour: Object.values(FAUCETS)
    .filter((f) => f.account !== 'faucet:signup')
    .reduce((sum, f) => sum + f.perHour, 0),
  /** With at least this many earners in the hour, the top 0.1% are flagged too. */
  percentileFrom: 200,
  /** A balance above this goes to the review queue ($1,000,000). */
  largeBalance: 100_000_000,
  /** Payments in a day: this many between one pair, or to one player from this many senders. */
  pairPayments: 10,
  fanIn: 6,
  /** Money sent and sent back within a day, both at least this much ($5,000). */
  roundTrip: 500_000,
} as const;
