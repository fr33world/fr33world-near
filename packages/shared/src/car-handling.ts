/**
 * How each car drives and sounds (Phase 7), by model id (car-models.ts has the measured sizes
 * and engines; this is the character on top). The handling is the driver's own simulation
 * (apps/client driving.ts); the sound is everyone's (sounds.ts): a pitch, how many gears the
 * revs climb through, and how loud it is.
 */

export interface Handling {
  /** Weight (tonnes): heavier cars pick up and stop more slowly for the same engine. */
  mass: number;
  /** Which wheels the engine turns. */
  drive: 'front' | 'rear' | 'all';
  /** Tyre grip, steering lock (radians at a crawl), brakes and springs, against an average car. */
  grip: number;
  steer: number;
  brakes: number;
  springs: number;
  /** Off the hill roads: top speed (m/s) and the steepest grade it climbs (rise over run). */
  rough: { top: number; climb: number };
  /** The engine: pitch (1 = the recording), gears, loudness. */
  sound: { pitch: number; gears: number; loud: number };
  /** The horn's pitch (Hz). */
  horn: number;
  /**
   * The driver's hips in car space (m): to the left of the middle (+x), above the ground, and
   * ahead of the middle (+z). The driver sits there, steering (apps/client seating.ts).
   */
  seat: [number, number, number];
}

const ROAD_CAR = { top: 7, climb: 0.25 };

export const HANDLING: Record<string, Handling> = {
  compact: {
    mass: 1.1,
    drive: 'front',
    grip: 0.95,
    steer: 0.66,
    brakes: 0.95,
    springs: 0.95,
    rough: ROAD_CAR,
    sound: { pitch: 1.18, gears: 5, loud: 0.75 },
    horn: 520,
    seat: [0.33, 0.56, 0.2],
  },
  hatchback: {
    mass: 1.25,
    drive: 'front',
    grip: 1,
    steer: 0.64,
    brakes: 1,
    springs: 1,
    rough: ROAD_CAR,
    sound: { pitch: 1.1, gears: 5, loud: 0.8 },
    horn: 500,
    seat: [0.38, 0.62, 0.15],
  },
  sedan: {
    mass: 1.45,
    drive: 'front',
    grip: 1,
    steer: 0.6,
    brakes: 1,
    springs: 1,
    rough: ROAD_CAR,
    sound: { pitch: 1, gears: 5, loud: 0.85 },
    horn: 470,
    seat: [0.38, 0.6, 0.1],
  },
  wagon: {
    mass: 1.55,
    drive: 'rear',
    grip: 0.97,
    steer: 0.58,
    brakes: 1,
    springs: 1,
    rough: ROAD_CAR,
    sound: { pitch: 0.95, gears: 5, loud: 0.85 },
    horn: 460,
    seat: [0.38, 0.6, 0.15],
  },
  coupe: {
    mass: 1.4,
    drive: 'rear',
    grip: 1.08,
    steer: 0.6,
    brakes: 1.1,
    springs: 1.15,
    rough: ROAD_CAR,
    sound: { pitch: 0.92, gears: 6, loud: 1.05 },
    horn: 480,
    seat: [0.38, 0.55, 0.0],
  },
  sport: {
    mass: 1.3,
    drive: 'all',
    grip: 1.25,
    steer: 0.58,
    brakes: 1.3,
    springs: 1.4,
    rough: { top: 5, climb: 0.2 },
    sound: { pitch: 1.25, gears: 6, loud: 1.25 },
    horn: 540,
    seat: [0.38, 0.22, 0.0],
  },
  suv: {
    mass: 2.1,
    drive: 'all',
    grip: 0.95,
    steer: 0.52,
    brakes: 0.9,
    springs: 0.85,
    rough: { top: 10, climb: 0.33 },
    sound: { pitch: 0.78, gears: 5, loud: 1 },
    horn: 400,
    seat: [0.4, 0.78, 0.2],
  },
  minivan: {
    mass: 1.9,
    drive: 'front',
    grip: 0.9,
    steer: 0.54,
    brakes: 0.9,
    springs: 0.8,
    rough: ROAD_CAR,
    sound: { pitch: 0.9, gears: 5, loud: 0.85 },
    horn: 430,
    seat: [0.4, 0.78, 0.45],
  },
  pickup: {
    mass: 2.2,
    drive: 'rear',
    grip: 0.9,
    steer: 0.5,
    brakes: 0.88,
    springs: 0.9,
    rough: { top: 10, climb: 0.33 },
    sound: { pitch: 0.72, gears: 4, loud: 1.1 },
    horn: 380,
    seat: [0.4, 0.78, 0.55],
  },
  offroad: {
    mass: 1.9,
    drive: 'all',
    grip: 1,
    steer: 0.56,
    brakes: 0.95,
    springs: 0.75,
    rough: { top: 14, climb: 0.45 },
    sound: { pitch: 0.75, gears: 4, loud: 1.05 },
    horn: 410,
    seat: [0.4, 0.72, 0],
  },
  taxi: {
    mass: 1.6,
    drive: 'rear',
    grip: 1,
    steer: 0.58,
    brakes: 1,
    springs: 1,
    rough: ROAD_CAR,
    sound: { pitch: 0.92, gears: 5, loud: 0.9 },
    horn: 450,
    seat: [0.38, 0.66, 0.2],
  },
  police: {
    mass: 1.7,
    drive: 'rear',
    grip: 1.15,
    steer: 0.6,
    brakes: 1.2,
    springs: 1.2,
    rough: ROAD_CAR,
    sound: { pitch: 0.95, gears: 6, loud: 1.15 },
    horn: 460,
    seat: [0.36, 0.5, 0.1],
  },
  ambulance: {
    mass: 3,
    drive: 'rear',
    grip: 0.9,
    steer: 0.5,
    brakes: 0.85,
    springs: 0.9,
    rough: ROAD_CAR,
    sound: { pitch: 0.8, gears: 5, loud: 1 },
    horn: 390,
    seat: [0.42, 0.95, 1.1],
  },
};

/** A car's handling by model id, the sedan's for anything unlisted. */
/** Seats beside the driver: three in most cars, one in a two-seat sports car. */
export const PASSENGER_SEATS = { default: 3, sport: 1 } as const;
export const passengerSeats = (id: string | undefined): number =>
  id === 'sport' ? PASSENGER_SEATS.sport : PASSENGER_SEATS.default;

/** How far back of the front seats the rear ones sit, and the top speed to climb in at (m/s). */
export const REAR_ROW = 0.85;
export const BOARD_SPEED = 3;

export function handlingOf(id: string | undefined): Handling {
  return HANDLING[id ?? ''] ?? (HANDLING.sedan as Handling);
}

/**
 * The engine's revs (0–1) at `speed` (m/s) in a car topping out at `top`, through `gears`:
 * climbing through each gear and dropping back at the shift, with a little more for throttle.
 */
export function engineRevs(speed: number, top: number, gears: number, throttle: number): number {
  const s = Math.min(1, Math.abs(speed) / Math.max(1, top));
  // Lower gears are shorter: gear k ends at (k/gears)^0.8 of the top speed.
  let lo = 0;
  for (let k = 1; k <= gears; k += 1) {
    const hi = (k / gears) ** 0.8;
    if (s <= hi || k === gears) {
      const within = (s - lo) / (hi - lo);
      const floor = k === 1 ? 0.18 : 0.42;
      return Math.min(1, floor + within * (1 - floor) * 0.85 + Math.max(0, throttle) * 0.12);
    }
    lo = hi;
  }
  return 1;
}
