/**
 * Homes players own (owner, 2026-11-13): the 36 hill villas, each bought for `$` at its door and
 * minted to the buyer's own NEAR wallet as its title deed (the homes contract: contracts/cars'
 * code under its own name, shared HOME_ASSETS). Like a car, a home is the holder's on chain,
 * whatever the game later thinks of them, and can be sent to any NEAR account.
 *
 * The catalogue is fixed here so the API needn't build the hills: index = the villa's number,
 * in city villaHomes() order (packages/city checks the two agree), with its street address and
 * ground-floor area in m².
 */

/** [street address, floor area m²], by villa number. */
export const HOMES: readonly (readonly [string, number])[] = [
  ['100 Observatory Road', 307],
  ['102 Observatory Road', 285],
  ['105 Observatory Road', 304],
  ['106 Observatory Road', 250],
  ['109 Observatory Road', 261],
  ['110 Observatory Road', 315],
  ['112 Observatory Road', 216],
  ['114 Observatory Road', 298],
  ['117 Observatory Road', 302],
  ['119 Observatory Road', 249],
  ['121 Observatory Road', 330],
  ['100 Crest Drive', 241],
  ['102 Crest Drive', 288],
  ['104 Crest Drive', 339],
  ['107 Crest Drive', 244],
  ['109 Crest Drive', 216],
  ['111 Crest Drive', 322],
  ['113 Crest Drive', 295],
  ['115 Crest Drive', 230],
  ['117 Crest Drive', 298],
  ['118 Crest Drive', 288],
  ['100 Mirador Drive', 342],
  ['102 Mirador Drive', 346],
  ['104 Mirador Drive', 342],
  ['107 Mirador Drive', 346],
  ['108 Mirador Drive', 322],
  ['101 Sycamore Drive', 360],
  ['100 Lago Drive', 357],
  ['102 Lago Drive', 252],
  ['105 Lago Drive', 212],
  ['106 Lago Drive', 334],
  ['108 Lago Drive', 220],
  ['100 Quarry Road', 270],
  ['102 Quarry Road', 302],
  ['104 Quarry Road', 317],
  ['107 Quarry Road', 257],
];

/** The homes contract, and the house rules (contracts/cars' code; shared CAR_ASSETS for cars). */
export const HOME_ASSETS = {
  /** The part before `.fr33world.testnet`. */
  account: 'homes',
  name: 'fr33world homes',
  symbol: 'F33HOME',
  /** Homes one player may own. */
  perPlayer: 2,
  /** Where each home's picture is, for its title deed in wallets: `villa-<n>.webp`. */
  mediaBase: 'https://fr33worldgame.xyz/ui/homes/',
} as const;

/** A home's price in cents: a base, and more for a bigger house, in steps of $5,000. */
export function homePrice(villa: number): number | null {
  const h = HOMES[villa];
  if (!h) return null;
  return Math.round((250_000 + h[1] * 1_250) / 5_000) * 5_000 * 100;
}

/** A home's token id: its number and a random tag, as for cars (shared carToken). */
export const homeToken = (villa: number | string, tag: string) => `home-${villa}-${tag}`;

/** A home's title on chain and in wallets: "Villa, 104 Crest Drive". */
export const homeTitle = (villa: number) => `Villa, ${HOMES[villa]?.[0] ?? `#${villa}`}`;
