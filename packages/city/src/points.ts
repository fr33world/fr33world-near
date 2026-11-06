/**
 * Interaction points (Phase 4, jobs in Phase 6): fixed places in the city a player can use.
 * Client and server build the same list from the layout, so a point is named by its index in
 * both, and the server checks a claimed use with `canReach` before acting on it.
 *   info           the plaza's info kiosk (the city guide)
 *   depot          Courier Depot's parcel lockers on the plaza: courier shifts start here
 *   door           a building's front door on the sidewalk, with its street address
 *   quarry_office  the quarry's site office at its gate: mining shifts start here
 *   ore            a rock face in the quarry with ore in it (`grade`: 0 copper, 1 iron, 2 gold)
 *   buyer          the ore buyer at the port
 *   parking        a car park's entrance: players get their own car here (parking.ts)
 *   dealer         the dealership's sales desk: cars are bought here (dealership.ts)
 *   gunstore       Gun Store, a shop in Mid City: the pistol licence, pistols and rounds
 *   black_market   a dealer behind the port's warehouses: rifles, for gangs (Phase 8–9)
 *   taxi_depot     the office by the plaza: taxi shifts start here (a company cab)
 *   fare           a curbside spot where a taxi fare waits or is let out (a door's address)
 *   hideout        a gang's hideout (`gang`): its collections start here
 *   entrance       the marker outside a public building (`service`): steps you inside it
 *   exit           the marker inside one: back out to the street
 *   locker         police and EMS go on and off duty here
 *   counter        the Hospital's counter: medicine and bandages
 *   computer       recruiters read applications and set interviews here
 */
import { districtAt, inside, QUARRY } from './plan.ts';
import { DOOR, INTERIORS, interiorSolids, SERVICE_IDS, type ServiceId } from './interiors.ts';
import type { Solid } from './landmarks.ts';
import { carriageHalfWidth, type Building, type Rect, type Road, roadHalfWidth } from './layout.ts';
import type { Dealership } from './dealership.ts';
import type { ParkingLot } from './parking.ts';
import { hash2, rng } from './random.ts';

export type PointKind =
  | 'info'
  | 'depot'
  | 'door'
  | 'quarry_office'
  | 'ore'
  | 'buyer'
  | 'parking'
  | 'dealer'
  | 'gunstore'
  | 'black_market'
  | 'taxi_depot'
  | 'fare'
  | 'hideout'
  | 'entrance'
  | 'exit'
  | 'locker'
  | 'counter'
  | 'computer'
  | 'till'
  | 'dock'
  | 'bay';

export interface InteractionPoint {
  kind: PointKind;
  /** Where the player stands to use it, and the way its front faces (yaw: 0 = +z). */
  x: number;
  z: number;
  yaw: number;
  /** How close (m, horizontally) a player must be to use it. */
  radius: number;
  /** A name players see: a door's street address, a place's name. */
  name?: string;
  /** An ore face's grade (0 copper, 1 iron, 2 gold). */
  grade?: number;
  /** A hideout's gang (shared FactionId). */
  gang?: string;
  /** The public building an entrance, exit or locker belongs to. */
  service?: ServiceId;
  /** An entrance: the middle of the building's front, for its sign. */
  front?: { x: number; z: number };
}

/** Slack on the server for where a client's player is between snapshots (m). */
const REACH_SLACK = 1;

/** May a player at (x, z) use `point`? (The server's check, with a little slack.) */
export function canReach(point: InteractionPoint, x: number, z: number): boolean {
  return Math.hypot(point.x - x, point.z - z) <= point.radius + REACH_SLACK;
}

/** The info kiosk's footprint: 1.2 m wide, 0.4 m deep, 2.4 m tall. */
export const KIOSK = { width: 1.2, depth: 0.4, height: 2.4 } as const;
/** The parcel lockers: 3 m wide, 0.8 m deep, 2.2 m tall. */
export const LOCKERS = { width: 3, depth: 0.8, height: 2.2 } as const;
/** The ore faces: rough boulders about this wide. */
export const ORE_SIZE = 2.6;
export const ORE_GRADES = ['Copper', 'Iron', 'Gold'] as const;

/** Districts with streets of houses, shops and offices to deliver to. */
const DELIVERY_DISTRICTS = new Set([
  'downtown',
  'arts',
  'mid_city',
  'palm_heights',
  'south_grid',
  'eastside',
]);
const MAX_DOORS = 260;

/** A box solid for something of `w` × `d` facing `yaw` (0 or ±π/2 only) at (x, z). */
function box(x: number, z: number, yaw: number, w: number, d: number, h: number): Solid {
  const across = Math.abs(Math.sin(yaw)) > 0.5;
  const hw = (across ? d : w) / 2;
  const hd = (across ? w : d) / 2;
  return { x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd, y0: 0, y1: h };
}

/** Building doors: the sidewalk in front of each building that faces a street. */
function doors(
  roads: Road[],
  buildings: Building[],
  seed: number,
  anywhere = false,
): InteractionPoint[] {
  const found: InteractionPoint[] = [];
  for (const b of buildings) {
    if (b.y !== undefined || b.drive || (b.service && !anywhere)) continue;
    if (!anywhere && !DELIVERY_DISTRICTS.has(districtAt(b.x, b.z))) continue;
    let best: { r: Road; gap: number; side: number } | null = null;
    for (const r of roads) {
      const along = r.axis === 'ns' ? b.z : b.x;
      if (along < r.from + 14 || along > r.to - 14) continue;
      const off = (r.axis === 'ns' ? b.x : b.z) - r.center;
      const half = (r.axis === 'ns' ? b.w : b.d) / 2;
      const gap = Math.abs(off) - half - roadHalfWidth(r);
      if (gap > -0.5 && gap < 4 && (!best || gap < best.gap))
        best = { r, gap, side: Math.sign(off) };
    }
    if (!best) continue;
    const { r, side } = best;
    // Not at a junction: no road of the other axis crossing within 12 m.
    const along = r.axis === 'ns' ? b.z : b.x;
    const crossing = roads.some(
      (c) =>
        c.axis !== r.axis &&
        Math.abs(c.center - along) < roadHalfWidth(c) + 12 &&
        r.center >= c.from &&
        r.center <= c.to,
    );
    if (crossing) continue;
    const out = carriageHalfWidth(r) + r.sidewalk * 0.55;
    const x = r.axis === 'ns' ? r.center + side * out : b.x;
    const z = r.axis === 'ns' ? b.z : r.center + side * out;
    // The door faces the street (from the building towards the road).
    const yaw = r.axis === 'ns' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0;
    const number = 100 + Math.round(Math.abs(along - r.from) / 12) * 2 + (side > 0 ? 1 : 0);
    found.push({ kind: 'door', x, z, yaw, radius: 2.4, name: `${number} ${r.name}` });
  }
  // A fixed, even sample when there are more than enough.
  if (found.length <= MAX_DOORS) return found;
  // (A seeded Fisher–Yates shuffle: the same on every engine, unlike sort with a random order.)
  const pick = rng(hash2(seed, 0xd00e));
  const shuffled = [...found];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = pick.int(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j] as InteractionPoint, shuffled[i] as InteractionPoint];
  }
  return shuffled.slice(0, MAX_DOORS);
}

/**
 * The points, and the solids their furniture adds. The info kiosk stands on the plaza's south
 * path between the fountain and Grand Avenue; Courier Depot's lockers on the west path.
 */
export function cityPoints(
  plaza: Rect,
  roads: Road[] = [],
  buildings: Building[] = [],
  seed = 1,
  lots: ParkingLot[] = [],
  dealer?: Dealership,
): { points: InteractionPoint[]; solids: Solid[] } {
  const sites = publicBuildings(roads, buildings, seed);
  const cx = (plaza.x0 + plaza.x1) / 2;
  const cz = (plaza.z0 + plaza.z1) / 2;
  const kiosk = { x: cx, z: cz + 15 };
  const points: InteractionPoint[] = [
    { kind: 'info', x: kiosk.x, z: kiosk.z + 1.2, yaw: 0, radius: 2.2, name: 'City guide' },
  ];
  const solids: Solid[] = [box(kiosk.x, kiosk.z, 0, KIOSK.width, KIOSK.depth, KIOSK.height)];

  // The depot: lockers on the west path, facing the fountain (+x).
  const depot = { x: plaza.x0 + 8, z: cz };
  points.push({
    kind: 'depot',
    x: depot.x + 1.6,
    z: depot.z,
    yaw: Math.PI / 2,
    radius: 2.6,
    name: 'Courier Depot',
  });
  solids.push(box(depot.x, depot.z, Math.PI / 2, LOCKERS.width, LOCKERS.depth, LOCKERS.height));

  if (roads.length > 0) {
    points.push(...doors(roads, buildings, seed));

    // The quarry: the site office by the gate, ore faces across the pit floor.
    const gate = { x: 1180, z: QUARRY.z1 - 40 };
    // Beside Quarry Road's last stretch (it runs in along gate.z), facing it from the south.
    // It stood on the road once, and the server turned down every car that drove up to it.
    points.push({
      kind: 'quarry_office',
      x: gate.x + 14,
      z: gate.z + 9,
      yaw: Math.PI,
      radius: 2.6,
      name: 'Quarry site office',
    });
    solids.push(box(gate.x + 14, gate.z + 12.5, Math.PI, 5, 3, 3));
    const pick = rng(hash2(seed, 0x0e5));
    const faces: [number, number][] = [];
    for (let tries = 0; faces.length < 8 && tries < 400; tries += 1) {
      const x = QUARRY.x0 + 40 + pick.next() * (QUARRY.x1 - QUARRY.x0 - 80);
      const z = QUARRY.z0 + 40 + pick.next() * (QUARRY.z1 - QUARRY.z0 - 110);
      if (!inside(QUARRY, x, z)) continue;
      if (faces.some(([fx, fz]) => Math.hypot(fx - x, fz - z) < 30)) continue;
      if (Math.hypot(x - gate.x, z - gate.z) < 40) continue;
      faces.push([x, z]);
    }
    faces.forEach(([x, z], i) => {
      // Gold is rare: one face; iron a few; copper the rest.
      const grade = i === 0 ? 2 : i < 3 ? 1 : 0;
      solids.push({
        x0: x - ORE_SIZE / 2,
        x1: x + ORE_SIZE / 2,
        z0: z - ORE_SIZE / 2,
        z1: z + ORE_SIZE / 2,
        y0: 0,
        y1: 2,
      });
      points.push({
        kind: 'ore',
        x,
        z: z + ORE_SIZE / 2 + 1,
        yaw: Math.PI,
        radius: 2.4,
        name: `${ORE_GRADES[grade]} face`,
        grade,
      });
    });

    // The buyer: Harbor Metals, on Dock Street's east sidewalk in the port.
    const dock = roads.find((r) => r.name === 'Dock St' && r.axis === 'ns');
    if (dock) {
      const x = dock.center + carriageHalfWidth(dock) + dock.sidewalk * 0.55;
      points.push({
        kind: 'buyer',
        x,
        z: 420,
        yaw: -Math.PI / 2,
        radius: 2.6,
        name: 'Harbor Metals',
      });
    }
  }
  for (const lot of lots)
    points.push({ kind: 'parking', ...lot.entrance, radius: 5, name: lot.name });
  if (dealer) points.push({ kind: 'dealer', ...dealer.desk, radius: 3.5, name: dealer.name });
  if (roads.length > 0) {
    // Gun Store: the shop door in Mid City nearest this spot takes the gun store's sign.
    const shop = points
      .filter((p) => p.kind === 'door' && districtAt(p.x, p.z) === 'mid_city')
      .reduce<InteractionPoint | null>(
        (best, p) =>
          !best || Math.hypot(p.x + 560, p.z - 240) < Math.hypot(best.x + 560, best.z - 240)
            ? p
            : best,
        null,
      );
    if (shop) points.push({ ...shop, kind: 'gunstore', radius: 2.6, name: 'Gun Store' });
    // The black market: down Dock Street past the warehouses, on its east sidewalk.
    const docks = roads.filter((r) => r.name === 'Dock St' && r.axis === 'ns');
    const at = docks.find((r) => r.from < 940 && r.to > 940) ?? docks[0];
    if (at)
      points.push({
        kind: 'black_market',
        x: at.center + carriageHalfWidth(at) + at.sidewalk * 0.55,
        z: Math.min(at.to - 10, 940),
        yaw: -Math.PI / 2,
        radius: 2.4,
        name: 'A man by the containers',
      });

    // Taxi Office: an office on the plaza's south edge, facing Grand Avenue.
    points.push({
      kind: 'taxi_depot',
      x: cx - 26,
      z: plaza.z1 - 1.6,
      yaw: 0,
      radius: 2.6,
      name: 'Taxi Office',
    });
    // Fares wait at the curb in front of every fourth address: on the carriageway's edge, where
    // a car can pull up (the door's own spot is on the sidewalk).
    const doorList = points.filter((q) => q.kind === 'door');
    doorList.forEach((d, k) => {
      if (k % 4 !== 0) return;
      const road = roads
        .filter((r) => {
          const along = r.axis === 'ns' ? d.z : d.x;
          const off = Math.abs((r.axis === 'ns' ? d.x : d.z) - r.center);
          return along > r.from && along < r.to && off < roadHalfWidth(r) + 2;
        })
        .sort(
          (a, b) =>
            Math.abs((a.axis === 'ns' ? d.x : d.z) - a.center) -
            Math.abs((b.axis === 'ns' ? d.x : d.z) - b.center),
        )[0];
      if (!road) return;
      const side = Math.sign((road.axis === 'ns' ? d.x : d.z) - road.center) || 1;
      const edge = road.center + side * (carriageHalfWidth(road) - 1.6);
      points.push({
        kind: 'fare',
        x: road.axis === 'ns' ? edge : d.x,
        z: road.axis === 'ns' ? d.z : edge,
        yaw: d.yaw,
        radius: 7,
        name: d.name,
      });
    });
    // The gangs' hideouts: beside the door of each one's house, on its turf.
    for (const [id, gang, name] of [
      ['vipers', 'vipers', 'Vipers hideout'],
      ['kings', 'kings', 'Kings hideout'],
    ] as const) {
      const d = sites.find((s) => s.service === id);
      if (!d) continue;
      const x = d.x + Math.cos(d.yaw) * 4.5;
      const z = d.z - Math.sin(d.yaw) * 4.5;
      points.push({ kind: 'hideout', x, z, yaw: d.yaw, radius: 2.6, name, gang });
    }
  }
  points.push(...sites);
  // Last, so every older point keeps its index.
  for (const service of SERVICE_IDS) {
    const room = INTERIORS[service];
    for (const p of room.points) points.push({ ...p, service });
  }
  // Deliveries for USDC (Phase 17): from a warehouse's dock to the Market's loading bay.
  const shop = sites.find((q) => q.service === 'market');
  if (shop) {
    const far = (b: Building) => Math.hypot(b.x - shop.x, b.z - shop.z);
    const sheds = buildings
      .filter((b) => b.style === 'warehouse' && !b.service && far(b) > 350)
      .sort((a, b) => far(a) - far(b));
    for (const b of sheds) {
      const [door] = doors(roads, [b], seed, true);
      if (!door) continue;
      points.push({ ...door, kind: 'dock', radius: 5, name: 'Harbor Wholesale' });
      points.push({
        kind: 'bay',
        x: shop.x + Math.cos(shop.yaw) * 7,
        z: shop.z - Math.sin(shop.yaw) * 7,
        yaw: shop.yaw,
        radius: 4,
        name: 'Market loading bay',
      });
      break;
    }
  }
  solids.push(...interiorSolids());
  return { points, solids };
}

/** Where each public building goes: near this spot in this district, big enough for it. */
const SITES: [ServiceId, string, number, number, number][] = [
  ['police', 'downtown', 240, -300, 16],
  ['hospital', 'medical', 1024, -130, 18],
  ['vipers', 'eastside', 1000, -300, 9],
  ['kings', 'south_grid', -300, 1100, 9],
  ['market', 'downtown', 40, -160, 12],
];

/**
 * Takes a street-front building for each public building: restyled here, so client and server
 * agree, and its door's sidewalk becomes the entrance.
 */
function publicBuildings(roads: Road[], buildings: Building[], seed: number): InteractionPoint[] {
  const sites: InteractionPoint[] = [];
  for (const [service, district, ax, az, size] of SITES) {
    const near = (b: Building) => Math.hypot(b.x - ax, b.z - az);
    const taken = buildings
      .filter(
        (b) =>
          districtAt(b.x, b.z) === district &&
          !b.service &&
          Math.min(b.w, b.d) >= size &&
          b.style !== 'civic',
      )
      .sort((a, b) => near(a) - near(b));
    for (const b of taken) {
      const [door] = doors(roads, [b], seed, true);
      if (!door) continue;
      const room = INTERIORS[service];
      b.service = service;
      if (service === 'police' || service === 'hospital') {
        b.style = 'civic';
        b.h = Math.min(Math.max(b.h, service === 'police' ? 13 : 20), 24);
        b.floorHeight = 3.8;
      } else {
        b.style = 'brick_loft';
        b.h = Math.min(b.h, 11);
      }
      const front = {
        x: b.x + (Math.sin(door.yaw) * b.w) / 2,
        z: b.z + (Math.cos(door.yaw) * b.d) / 2,
      };
      sites.push({
        ...door,
        // On the doorstep, not out on the sidewalk: walking up to the door has to work.
        x: front.x + Math.sin(door.yaw) * DOOR.entranceM,
        z: front.z + Math.cos(door.yaw) * DOOR.entranceM,
        kind: 'entrance',
        radius: DOOR.entranceRadius,
        name: room.name,
        service,
        front,
      });
      break;
    }
  }
  return sites;
}

/** Whether a point is in the quarry (for the client's dressing). */
export const inQuarry = (p: InteractionPoint) => inside(QUARRY, p.x, p.z);
