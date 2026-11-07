import { describe, expect, it } from 'vitest';
import { CollisionIndex } from './collision.ts';
import { INTERIORS, interiorAt, interiorSolids, type ServiceId } from './interiors.ts';
import { generateCity, roadHalfWidth } from './layout.ts';
import { canReach } from './points.ts';
import { dropOff } from './taxi.ts';
import {
  districtAt,
  inside,
  isLand,
  isWalkable,
  PARKWAY_HALF,
  PIER,
  RIVER,
  SOL_CORRIDOR,
  SOL_ELEVATED,
  SOL_FREEWAY_Z,
  VALLEY_CORRIDOR,
  VALLEY_ELEVATED,
  VALLEY_FREEWAY_X,
} from './plan.ts';

describe('city layout', () => {
  const city = generateCity();
  const collision = CollisionIndex.fromCity(city);

  it('is deterministic for a seed and different for another', () => {
    expect(generateCity()).toEqual(city);
    expect(generateCity(7).buildings).not.toEqual(city.buildings);
  });

  it('is a whole city: streets, thousands of buildings, palms, lights, cars and spawns', () => {
    expect(city.roads.length).toBeGreaterThan(35);
    expect(city.buildings.length).toBeGreaterThan(1500);
    expect(city.palms.length).toBeGreaterThan(500);
    expect(city.lights.length).toBeGreaterThan(2000);
    expect(city.vehicleSpawns.length).toBeGreaterThanOrEqual(6);
    expect(city.playerSpawns.length).toBeGreaterThan(0);
    const towers = city.buildings.filter((b) => b.h >= 100);
    expect(towers.length).toBeGreaterThan(2);
  });

  it('keeps the prototype downtown: its plaza, street names and widths', () => {
    expect(city.plaza).toEqual({ x0: -108.5, x1: -19.5, z0: -108.5, z1: -15.5 });
    const names = new Set(city.roads.map((r) => r.name));
    for (const n of ['Sol Boulevard', 'Hope St', 'Grand Avenue', 'Figueroa St', '7th St']) {
      expect(names.has(n)).toBe(true);
    }
    expect(names.has('Estrella Boulevard')).toBe(true);
  });

  it('builds each district its own way', () => {
    const styleIn = (d: string) =>
      new Set(city.buildings.filter((b) => districtAt(b.x, b.z) === d).map((b) => b.style));
    expect(styleIn('downtown').has('glass_tower')).toBe(true);
    expect(styleIn('palm_heights').has('villa')).toBe(true);
    expect(styleIn('south_grid').has('house')).toBe(true);
    expect(styleIn('port').has('warehouse')).toBe(true);
  });

  it('puts the stadium on its own lot on Stadium Hill: a closed oval with light towers', () => {
    const st = city.landmarks.stadium;
    expect(districtAt(st.x, st.z)).toBe('stadium_hill');
    // Big enough for a pitch and stands, inside its lot, nothing else built there.
    expect(st.rx).toBeGreaterThan(90);
    expect(st.rz).toBeGreaterThan(75);
    expect(st.x - st.rx).toBeGreaterThan(st.lot.x0);
    expect(st.x + st.rx).toBeLessThan(st.lot.x1);
    expect(st.z - st.rz).toBeGreaterThan(st.lot.z0);
    expect(st.z + st.rz).toBeLessThan(st.lot.z1);
    expect(city.blocks).toContain(st.lot);
    for (const b of city.buildings) expect(inside(st.lot, b.x, b.z)).toBe(false);
    // The wall is solid all the way round, and only near it: the corners of the lot are open.
    const index = CollisionIndex.fromCity(city);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
      const [x, z] = [st.x + Math.cos(a) * st.rx, st.z + Math.sin(a) * st.rz];
      expect(index.pointBlocked(x, z, 0.3)).toBe(true);
    }
    expect(index.pointBlocked(st.lot.x0 + 4, st.lot.z0 + 4, 0.3)).toBe(false);
    expect(index.pointBlocked(st.x, st.z, 0.3)).toBe(false);
    expect(st.towers).toHaveLength(4);
  });

  it('puts each public entrance on its doorstep, its ring reaching the wall', () => {
    const entrances = city.points.filter((p) => p.kind === 'entrance');
    expect(entrances).toHaveLength(5);
    for (const p of entrances) {
      const front = p.front as { x: number; z: number };
      expect(Math.hypot(p.x - front.x, p.z - front.z)).toBeLessThan(p.radius - 0.3);
    }
  });

  it('has parking close to the places people go', () => {
    const lots = city.points.filter((p) => p.kind === 'parking');
    const places = city.points.filter((p) =>
      ['entrance', 'dock', 'buyer', 'black_market'].includes(p.kind),
    );
    for (const p of places) {
      const nearest = Math.min(...lots.map((l) => Math.hypot(l.x - p.x, l.z - p.z)));
      expect(nearest, p.name).toBeLessThan(150);
    }
    for (const lot of city.parking) expect(lot.bays.length, lot.name).toBeGreaterThan(5);
  });

  it('keeps every public place where players know it', () => {
    const at = (kind: string, service?: string) => {
      const p = city.points.find((q) => q.kind === kind && (!service || q.service === service));
      return p && [Math.round(p.x), Math.round(p.z)];
    };
    expect(at('entrance', 'police')).toEqual([250, -302]);
    expect(at('entrance', 'hospital')).toEqual([1068, -180]);
    expect(at('entrance', 'vipers')).toEqual([1000, -368]);
    expect(at('entrance', 'kings')).toEqual([-322, 1094]);
    expect(at('entrance', 'market')).toEqual([18, -180]);
    expect(at('gunstore')).toEqual([-605, 250]);
    expect(at('dealer')).toEqual([-38, 267]);
  });

  it('places the landmarks: city hall facing the plaza, the observatory, sign and pier wheel', () => {
    const civic = city.buildings.filter((b) => b.style === 'civic' && !b.service);
    expect(civic).toHaveLength(3);
    const tower = civic.find((b) => b.h > 100);
    if (!tower) throw new Error('no city hall tower');
    // North of the plaza, across 7th St, and nothing else built on its block.
    expect(tower.z).toBeLessThan(city.plaza.z0);
    expect(Math.abs(tower.x - (city.plaza.x0 + city.plaza.x1) / 2)).toBeLessThan(20);
    const hallBlock = city.blocks.find(
      (r) => tower.x >= r.x0 && tower.x <= r.x1 && tower.z >= r.z0 && tower.z <= r.z1,
    );
    if (!hallBlock) throw new Error('no city hall block');
    const onBlock = city.buildings.filter(
      (b) =>
        b.x >= hallBlock.x0 && b.x <= hallBlock.x1 && b.z >= hallBlock.z0 && b.z <= hallBlock.z1,
    );
    expect(onBlock.every((b) => b.style === 'civic')).toBe(true);
    expect(districtAt(city.landmarks.observatory.x, city.landmarks.observatory.z)).toBe('hills');
    expect(city.landmarks.sign.letters.map((l) => l.char).join('')).toBe('LOSSOLES');
    // Sign letters, the wheel's four legs, the stadium's wall pieces and light towers are solid.
    // Landmarks, then the job and info points' furniture: the kiosk, the depot's lockers, the
    // quarry office and its eight ore faces.
    expect(city.solids).toHaveLength(8 + 4 + 72 + 4 + 1 + 1 + 1 + 8 + interiorSolids().length);
    const { wheel } = city.landmarks;
    expect(collision.pointBlocked(wheel.x + 2.5, wheel.z + 14, 0.2)).toBe(true);
    expect(collision.pointBlocked(wheel.x, wheel.z, 0.2)).toBe(false);
  });

  it('leads through the station: lobby, office door, far end of the office, then the cells', () => {
    const room = INTERIORS.police;
    const { x0, z0 } = room.rect;
    // Everywhere a body fits, walking from the door, without going through `shut`.
    const reach = (shut: (x: number, z: number) => boolean) => {
      const step = 0.25;
      const seen = new Set<string>();
      const open = [[room.spawn.x, room.spawn.z] as const];
      seen.add(`${room.spawn.x},${room.spawn.z}`);
      for (let i = 0; i < open.length; i += 1) {
        const [x, z] = open[i] as readonly [number, number];
        for (const [dx, dz] of [
          [step, 0],
          [-step, 0],
          [0, step],
          [0, -step],
        ] as const) {
          const [nx, nz] = [x + dx, z + dz];
          if (seen.has(`${nx},${nz}`) || shut(nx - x0, nz - z0)) continue;
          if (collision.pointBlocked(nx, nz, 0.3, 0)) continue;
          seen.add(`${nx},${nz}`);
          open.push([nx, nz]);
        }
      }
      return seen;
    };
    const near = (seen: Set<string>, x: number, z: number) =>
      [...seen].some((k) => {
        const [a, b] = k.split(',').map(Number) as [number, number];
        return Math.hypot(a - x, b - z) < 1;
      });
    const benches = room.seats.filter((s) => s.z - z0 > 9.1 && s.z - z0 < 10);
    expect(benches).toHaveLength(6);

    const all = reach(() => false);
    for (const p of room.points) expect(near(all, p.x, p.z), p.name).toBe(true);
    for (const s of benches) expect(near(all, s.x, s.z + 0.8)).toBe(true);

    // Shut the doorway at the far end of the office, and the lobby and office no longer reach them.
    const noCorridor = reach((x, z) => x > 12.9 && x < 13.3 && z > 14.5 && z < 17.5);
    for (const s of benches) expect(near(noCorridor, s.x, s.z + 0.8)).toBe(false);
    // Shut the office door, and the lobby reaches nothing behind it.
    const noOffice = reach((x, z) => z > 8.8 && z < 9.2);
    expect(near(noOffice, x0 + 6.2, z0 + 12)).toBe(false);
  });

  it('leaves the hospital ward door open to bodies', () => {
    const { x0, z0 } = INTERIORS.hospital.rect;
    expect(collision.segmentBlocked(x0 + 21, z0 + 8, x0 + 21, z0 + 12, 0.3, 0)).toBe(false);
  });

  it('has a pier out over the sea that bodies may stand on', () => {
    for (const p of PIER) {
      const x = (p.x0 + p.x1) / 2;
      const z = (p.z0 + p.z1) / 2;
      expect(isWalkable(x, z)).toBe(true);
      expect(isWalkable(x, p.z1 + 1)).toBe(false);
    }
    expect(isLand(-1400, 0)).toBe(false);
    expect(isWalkable(-1250, -100)).toBe(true);
    expect(isWalkable(-1300, -100)).toBe(false);
  });

  it('builds only on land, never in the freeway corridors or the river', () => {
    for (const b of city.buildings) {
      for (const [x, z] of [
        [b.x - b.w / 2, b.z - b.d / 2],
        [b.x + b.w / 2, b.z + b.d / 2],
      ] as const) {
        expect(isLand(x, z)).toBe(true);
      }
      for (const band of [
        SOL_ELEVATED,
        { ...SOL_CORRIDOR, z0: SOL_FREEWAY_Z - PARKWAY_HALF, z1: SOL_FREEWAY_Z + PARKWAY_HALF },
        VALLEY_ELEVATED,
        {
          ...VALLEY_CORRIDOR,
          x0: VALLEY_FREEWAY_X - PARKWAY_HALF,
          x1: VALLEY_FREEWAY_X + PARKWAY_HALF,
        },
        RIVER,
      ]) {
        const overlaps =
          b.x + b.w / 2 > band.x0 &&
          b.x - b.w / 2 < band.x1 &&
          b.z + b.d / 2 > band.z0 &&
          b.z - b.d / 2 < band.z1;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('never stands a freeway pillar on a street', () => {
    for (const f of city.freeways) {
      for (const p of f.pillars) {
        for (const r of city.roads) {
          const across = r.axis === 'ns' ? p.x : p.z;
          const along = r.axis === 'ns' ? p.z : p.x;
          if (along < r.from || along > r.to) continue;
          expect(Math.abs(across - r.center)).toBeGreaterThanOrEqual(roadHalfWidth(r));
        }
      }
    }
  });

  it('keeps every building off the roads and out of the plaza', () => {
    for (const b of city.buildings) {
      for (const r of city.roads) {
        const half = roadHalfWidth(r);
        const [across, along, size, length] =
          r.axis === 'ns' ? [b.x, b.z, b.w, b.d] : [b.z, b.x, b.d, b.w];
        if (along + length / 2 <= r.from || along - length / 2 >= r.to) continue;
        expect(Math.abs(across - r.center)).toBeGreaterThanOrEqual(half + size / 2 - 1e-6);
      }
      const p = city.plaza;
      const overlaps =
        b.x + b.w / 2 > p.x0 &&
        b.x - b.w / 2 < p.x1 &&
        b.z + b.d / 2 > p.z0 &&
        b.z - b.d / 2 < p.z1;
      expect(overlaps).toBe(false);
    }
  });

  it('spawns players and cars in the open', () => {
    for (const s of city.playerSpawns) expect(collision.pointBlocked(s.x, s.z, 0.4)).toBe(false);
    for (const v of city.vehicleSpawns) expect(collision.pointBlocked(v.x, v.z, 1)).toBe(false);
  });

  it('lets taxi passengers out on a clear sidewalk, never inside a building or out at sea', () => {
    const tower = city.buildings.find(
      (b) => b.style === 'glass_tower',
    ) as (typeof city.buildings)[number];
    const drop = dropOff(city, collision, tower.x, tower.z);
    expect(drop).not.toBeNull();
    if (!drop) return;
    expect(collision.pointBlocked(drop.x, drop.z, 0.5)).toBe(false);
    expect(isWalkable(drop.x, drop.z)).toBe(true);
    const sidewalk = city.roads.some((r) => {
      const off = Math.abs((r.axis === 'ns' ? drop.x : drop.z) - r.center);
      const along = r.axis === 'ns' ? drop.z : drop.x;
      return (
        along >= r.from &&
        along <= r.to &&
        off > r.lanesPerDir * r.laneWidth + r.median / 2 &&
        off < roadHalfWidth(r)
      );
    });
    expect(sidewalk).toBe(true);
    expect(dropOff(city, collision, city.bounds.x0 + 5, city.bounds.z0 + 5)).toBeNull();
  });

  it('puts the Car Dealership on Sol Boulevard: cars on show, a showroom, a desk and delivery bays', () => {
    const d = city.dealership;
    expect(d).not.toBeNull();
    if (!d) return;
    const sol = city.roads.find((r) => r.name === 'Sol Boulevard') as (typeof city.roads)[number];
    // Its front on the boulevard's sidewalk.
    expect(Math.min(Math.abs(d.rect.x0), Math.abs(d.rect.x1))).toBeCloseTo(roadHalfWidth(sol), 0);
    expect(city.buildings).toContain(d.showroom);
    // Nothing else stands on the plot.
    const onPlot = city.buildings.filter((b) => b !== d.showroom && inside(d.rect, b.x, b.z));
    expect(onPlot).toHaveLength(0);
    expect(d.display).toHaveLength(10);
    // Every car for sale and every delivery bay inside the plot, clear of the showroom and of
    // each other.
    const spots = [...d.display, ...d.delivery];
    for (const s of spots) {
      expect(inside(d.rect, s.x, s.z)).toBe(true);
      expect(collision.pointBlocked(s.x, s.z, 3)).toBe(false);
      for (const o of spots)
        if (o !== s) expect(Math.hypot(o.x - s.x, o.z - s.z)).toBeGreaterThan(3.2);
    }
    const desk = city.points.find((p) => p.kind === 'dealer');
    expect(desk).toMatchObject({ name: 'Car Dealership', x: d.desk.x, z: d.desk.z });
    expect(collision.pointBlocked(d.desk.x, d.desk.z, 1)).toBe(false);
  });
});

describe('collision index', () => {
  const index = new CollisionIndex([{ x0: 0, z0: 0, x1: 10, z1: 10 }]);

  it('blocks a segment that crosses a box and allows one that passes by', () => {
    expect(index.segmentBlocked(-5, 5, 15, 5, 0)).toBe(true);
    expect(index.segmentBlocked(-5, -5, 15, -5, 0)).toBe(false);
    expect(index.segmentBlocked(-5, -0.2, 15, -0.2, 0.3)).toBe(true);
  });

  it('catches a fast body tunnelling through between reports', () => {
    expect(index.segmentBlocked(-100, 5, 100, 5, 0.4)).toBe(true);
  });

  it('tests points with a radius, across cell borders', () => {
    expect(index.pointBlocked(5, 5, 0)).toBe(true);
    expect(index.pointBlocked(-0.3, 5, 0.4)).toBe(true);
    expect(index.pointBlocked(-1, 5, 0.4)).toBe(false);
  });

  it('puts the info kiosk on the plaza, reachable from its front only', () => {
    const city = generateCity();
    const collision = CollisionIndex.fromCity(city);
    const kiosk = city.points.find((p) => p.kind === 'info');
    expect(kiosk?.kind).toBe('info');
    if (!kiosk) return;
    expect(kiosk.x).toBeGreaterThan(city.plaza.x0);
    expect(kiosk.z).toBeLessThan(city.plaza.z1);
    expect(collision.pointBlocked(kiosk.x, kiosk.z, 0.4)).toBe(false);
    expect(canReach(kiosk, kiosk.x + 1, kiosk.z)).toBe(true);
    expect(canReach(kiosk, kiosk.x, kiosk.z + 5)).toBe(false);
  });

  it('has the job points: a depot, hundreds of doors on the sidewalks, the quarry and a buyer', () => {
    const city = generateCity();
    const collision = CollisionIndex.fromCity(city);
    const count = (k: string) => city.points.filter((p) => p.kind === k).length;
    expect(count('depot')).toBe(1);
    expect(count('door')).toBeGreaterThan(150);
    expect(count('quarry_office')).toBe(1);
    expect(count('ore')).toBe(8);
    expect(count('buyer')).toBe(1);
    for (const p of city.points) expect(collision.pointBlocked(p.x, p.z, 0.4), p.name).toBe(false);
    // Same points every time (client and server name them by index).
    expect(generateCity().points).toEqual(city.points);
  });
});

describe('join points', () => {
  it('tells outsiders how to join every faction, where they can reach it', () => {
    const joins = generateCity().points.filter((p) => p.kind === 'join');
    expect(joins.map((p) => p.service).sort()).toEqual(['hospital', 'kings', 'police', 'vipers']);
    for (const p of joins) {
      const room = interiorAt(p.x, p.z);
      // A gang's room is shut to outsiders, so theirs must be out in the street.
      expect(room === null).toBe(INTERIORS[p.service as ServiceId].members);
      if (!room) continue;
      const [x, z] = [p.x - room.rect.x0, p.z - room.rect.z0];
      for (const b of room.boxes.filter((q) => q.solid))
        expect(x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1).toBe(false);
    }
  });
});
