/** Colours and window bays shared by building walls (city.ts) and house details (homes.ts). */
import type { FacadeKind } from '../materials.ts';

/** LA palettes: pastel stucco, sandstone deco, pale office tiles, red-brown brick. */
export const TINTS: Record<FacadeKind, number[]> = {
  // Curtain-wall stone: the bands between ribbon windows, fins and podium trims.
  glass: [0xd8d4ca, 0xc2c6c7, 0xa9b0b4, 0xe2d8c4, 0x8f969b],
  tiles: [0xd9cdb6, 0xc7b89e, 0xbfb3a0, 0xa9a49a, 0xdcc6a2, 0xb79f82],
  stucco: [0xeed3b0, 0xe8b398, 0xdcc394, 0xc6d4b8, 0xf1e4cf, 0xd99c84, 0xc8b0d4, 0xe8c56c],
  brick: [0xffffff, 0xe8d0c0, 0xd0b8a8],
  cladding: [0xd8d8d2, 0xc4cbd0, 0xb8b0a2],
};
export const BAY: Record<FacadeKind, number> = {
  glass: 1.6,
  tiles: 3.2,
  stucco: 3.6,
  brick: 3.0,
  cladding: 7,
};
