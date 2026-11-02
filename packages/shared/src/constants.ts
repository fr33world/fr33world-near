/**
 * World-wide numbers shared by the world server, the client and the load bots. Distances are
 * metres, speeds metres per second, the y axis is up, and (0, 0) is the city centre.
 */

/** The playable city is a square of 2 × WORLD_HALF metres (technical-plan §2: ~3 × 3 km). */
export const WORLD_HALF = 1536;

/** World server simulation and snapshot rate. */
export const TICK_HZ = 30;
/** How often a client reports its own body (character or the car it drives). */
export const CLIENT_SEND_HZ = 20;

/**
 * Snapshot tiers (technical-plan §6): the nearest players arrive every tick, the next ring at
 * half rate, the rest of the view at 5 Hz. Ranks are by distance, so a crowd of 500 in one
 * plaza still costs each client at most VIEW_MAX entities.
 */
export const AOI = {
  NEAR_RADIUS: 60,
  MID_RADIUS: 150,
  VIEW_RADIUS: 300,
  NEAR_MAX: 16,
  MID_MAX: 64,
  VIEW_MAX: 128,
  /** A body already in view stays until it falls out of the nearest VIEW_KEEP (hysteresis). */
  VIEW_KEEP: 160,
  /** Ticks between sends: 30 Hz, 15 Hz, 5 Hz. */
  NEAR_EVERY: 1,
  MID_EVERY: 2,
  FAR_EVERY: 6,
  /** An unchanged entity is still re-sent this often so late joiners and losses heal. */
  KEEPALIVE_TICKS: 30,
} as const;

/** Movement limits the server enforces (with MOVE_TOLERANCE headroom for jitter). */
export const SPEED = {
  WALK: 1.8,
  RUN: 6.2,
  /** Top speed of the fastest prototype car (~250 km/h). */
  VEHICLE_MAX: 70,
} as const;
export const MOVE_TOLERANCE = 1.35;

/** A player must be this close to a car door to be granted the seat. */
export const VEHICLE_ENTER_RADIUS = 4;

/** Server keeps this much pose history per player for lag-compensated hits. */
export const LAG_HISTORY_MS = 1000;
/** Shots are rewound at most this far back (technical-plan §9). */
export const LAG_COMP_MAX_MS = 200;
