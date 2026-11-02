/**
 * Street junctions and their furniture: where a north–south street meets an east–west one,
 * which legs it has, and where its poles stand. Junctions on a main road (two lanes or more)
 * with three legs or more get traffic signals: a mast arm on the far right corner of each
 * approach (right-hand traffic; the near right one where a T-junction has no far side)
 * reaching over that approach's lanes, a signal head above each lane. Every junction gets a street-name sign, on the signal pole when there is one.
 * Shared by the drawing (signals.ts) and the physics (poles are solid).
 */
import { carriageHalfWidth, type CityLayout, type Road } from '@fr33world/city';

/** Where an approach's traffic comes from. */
export type Leg = 'north' | 'south' | 'east' | 'west';

export interface SignalPole {
  /** The pole (on the sidewalk corner) and the approach it serves. */
  x: number;
  z: number;
  from: Leg;
  /** Unit direction its arm reaches (over the approach's lanes), and the lanes' centres along
   * it (m from the pole). */
  arm: [number, number];
  lanes: number[];
  /** 0: north–south traffic's phase, 1: east–west's. */
  group: 0 | 1;
}

export interface Junction {
  x: number;
  z: number;
  ns: Road;
  ew: Road;
  legs: Leg[];
  signals: SignalPole[];
  /** The street-name sign's post (a signal pole's, when it has signals). */
  sign: { x: number; z: number };
  /** Seconds the signal cycle is shifted by (a green wave along the main roads). */
  offset: number;
}

/** Poles stand this far back from the kerb (m). */
const BACK = 1;
export const POLE_HEIGHT = 6.6;
export const SIGN_POST_HEIGHT = 3.4;

export function junctions(city: CityLayout): Junction[] {
  const out = new Map<string, Junction>();
  const has = (axis: 'ns' | 'ew', line: number, a: number, b: number) =>
    city.roads.some(
      (r) =>
        r.axis === axis &&
        r.center === line &&
        r.from <= Math.min(a, b) + 1e-6 &&
        r.to >= Math.max(a, b) - 1e-6,
    );
  for (const ns of city.roads) {
    if (ns.axis !== 'ns') continue;
    for (const ew of city.roads) {
      if (ew.axis !== 'ew') continue;
      const [x, z] = [ns.center, ew.center];
      if (x < ew.from - 1e-6 || x > ew.to + 1e-6 || z < ns.from - 1e-6 || z > ns.to + 1e-6)
        continue;
      const key = `${x},${z}`;
      const prev = out.get(key);
      // Roads meeting end to end at a junction show up twice: keep the wider pair.
      if (prev && prev.ns.lanesPerDir >= ns.lanesPerDir && prev.ew.lanesPerDir >= ew.lanesPerDir)
        continue;
      const legs: Leg[] = [];
      if (has('ns', x, z - 20, z)) legs.push('north');
      if (has('ns', x, z, z + 20)) legs.push('south');
      if (has('ew', z, x, x + 20)) legs.push('east');
      if (has('ew', z, x - 20, x)) legs.push('west');
      const hx = carriageHalfWidth(ns) + BACK;
      const hz = carriageHalfWidth(ew) + BACK;
      const main = Math.max(ns.lanesPerDir, ew.lanesPerDir) >= 2 && legs.length >= 3;
      const signals: SignalPole[] = [];
      if (main) {
        const lanes = (r: Road) =>
          Array.from({ length: r.lanesPerDir }, (_, k) => r.median / 2 + r.laneWidth * (k + 0.5));
        // From each approach: the far right corner, its arm back across that approach's lanes.
        const make = (from: Leg): SignalPole => {
          switch (from) {
            case 'north': // southbound: right is west; the far corner is south-west
              return {
                x: x - hx,
                z: z + hz,
                from,
                arm: [1, 0],
                lanes: lanes(ns).map((l) => hx - l),
                group: 0,
              };
            case 'south': // northbound
              return {
                x: x + hx,
                z: z - hz,
                from,
                arm: [-1, 0],
                lanes: lanes(ns).map((l) => hx - l),
                group: 0,
              };
            case 'west': // eastbound: right is south; the far corner is south-east
              return {
                x: x + hx,
                z: z + hz,
                from,
                arm: [0, -1],
                lanes: lanes(ew).map((l) => hz - l),
                group: 1,
              };
            case 'east': // westbound
              return {
                x: x - hx,
                z: z - hz,
                from,
                arm: [0, 1],
                lanes: lanes(ew).map((l) => hz - l),
                group: 1,
              };
          }
        };
        const across: Record<Leg, Leg> = {
          north: 'south',
          south: 'north',
          east: 'west',
          west: 'east',
        };
        for (const leg of legs) {
          const pole = make(leg);
          // A T-junction with no street on the far side: the near right corner instead.
          if (!legs.includes(across[leg])) {
            if (leg === 'north' || leg === 'south') pole.z = 2 * z - pole.z;
            else pole.x = 2 * x - pole.x;
          }
          signals.push(pole);
        }
      }
      const signPole = signals.find((s) => s.from === 'south') ?? signals[0];
      out.set(key, {
        x,
        z,
        ns,
        ew,
        legs,
        signals,
        sign: signPole ? { x: signPole.x, z: signPole.z } : { x: x + hx, z: z - hz },
        // A green wave: about 10 m/s along both axes.
        offset: ((x + z) / 10) % 40,
      });
    }
  }
  return [...out.values()].filter((j) => j.legs.length >= 2);
}
