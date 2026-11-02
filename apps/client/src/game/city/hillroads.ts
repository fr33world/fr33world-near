/**
 * The hill roads (layout `hillRoads`, hillroads.ts in @fr33world/city): asphalt laid on the
 * graded terrain, widening where a road leaves a city street; a concrete curb strip along
 * each edge, white edge lines and a double yellow centre line; galvanised guard rails on
 * posts where the ground falls away (layout `guardRails`; physics.ts makes them solid).
 */
import {
  type CityLayout,
  HILL_HALF,
  type RampPoint,
  type Road,
  terrainHeight,
} from '@fr33world/city';
import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';
import { BIG_TILE, TiledGeo } from './tiles.ts';

/** Asphalt and paint just over the terrain they lie on (drawn with depth bias as well). */
const LIFT = 0.04;
const PAINT = 0.012;
/** Length over which a road narrows from the street it leaves to its own width (m). */
const TAPER = 30;
const RAIL_HEIGHT = 0.75;

/** Horizontal unit normals (left of travel) at each point, averaged at the joints. */
function normals(pts: readonly RampPoint[]): [number, number][] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)] as RampPoint;
    const b = pts[Math.min(pts.length - 1, i + 1)] as RampPoint;
    const n = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return [-(b.z - a.z) / n, (b.x - a.x) / n];
  });
}

/**
 * A flat strip along a line between offsets `c0(i)` and `c1(i)` from it, `dy` above the ground
 * (or above the line itself, when not `onGround`), in the tile of each piece's middle; `keep`
 * skips pieces (gaps at junctions).
 */
function strip(
  at: (x: number, z: number) => GeoBuilder,
  pts: readonly RampPoint[],
  ns: readonly [number, number][],
  c0: (i: number) => number,
  c1: (i: number) => number,
  dy: number,
  keep: (i: number) => boolean = () => true,
  onGround = true,
) {
  const up = { x: 0, y: 1, z: 0 };
  // On the ground there: the road's height, but where two roads meet the junction's blend.
  const v = (i: number, c: number) => {
    const p = pts[i] as RampPoint;
    const [nx, nz] = ns[i] as [number, number];
    const [x, z] = [p.x + nx * c, p.z + nz * c];
    return { x, y: (onGround ? terrainHeight(x, z) : p.y) + dy, z };
  };
  let along = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1] as RampPoint;
    const b = pts[i] as RampPoint;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const [u0, u1] = [along / 8, (along + len) / 8];
    along += len;
    if (!keep(i)) continue;
    const [a0, a1, b0, b1] = [c0(i - 1), c1(i - 1), c0(i), c1(i)];
    // Counter-clockwise from above: c0 → c1 at the start, then back at the end.
    at((a.x + b.x) / 2, (a.z + b.z) / 2).quad(v(i - 1, a0), v(i - 1, a1), v(i, b1), v(i, b0), up, [
      a0 / 8,
      u0,
      a1 / 8,
      u0,
      b1 / 8,
      u1,
      b0 / 8,
      u1,
    ]);
  }
}

/** Half the carriageway of the city street a hill road starts or ends at, if any. */
function streetHalf(roads: readonly Road[], p: RampPoint): number | null {
  const street = roads.find(
    (r) => r.axis === 'ns' && Math.abs(r.center - p.x) < 0.5 && Math.abs(r.from - p.z) < 0.5,
  );
  return street ? street.lanesPerDir * street.laneWidth + street.median / 2 : null;
}

export function buildHillRoads(
  city: CityLayout,
  m: { road: THREE.Material; curb: THREE.Material; rail: THREE.Material },
  far: number,
  near: number,
): THREE.Group[] {
  const surface = new TiledGeo(
    () => ({ road: new GeoBuilder(), curb: new GeoBuilder() }),
    BIG_TILE,
  );
  const paint = new TiledGeo(() => ({ white: new GeoBuilder(), yellow: new GeoBuilder() }));
  const rails = new TiledGeo(() => ({ rail: new GeoBuilder() }));

  for (const road of city.hillRoads) {
    const pts = road.points;
    const ns = normals(pts);
    const along = [0];
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1] as RampPoint;
      const b = pts[i] as RampPoint;
      along.push((along[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const total = along[along.length - 1] as number;
    const startHalf = streetHalf(city.roads, pts[0] as RampPoint);
    const endHalf = streetHalf(city.roads, pts[pts.length - 1] as RampPoint);
    const half = (i: number) => {
      const s = along[i] as number;
      let h = HILL_HALF;
      for (const [w, d] of [
        [startHalf, s],
        [endHalf, total - s],
      ] as const) {
        if (w === null || d >= TAPER) continue;
        const t = d / TAPER;
        h = Math.max(h, w + (HILL_HALF - w) * t * t * (3 - 2 * t));
      }
      return h;
    };
    // Lines stop short of where the road meets another (its asphalt runs on into the other's).
    const meets = (i: number, d: number) =>
      (road.leaves !== undefined && (along[i] as number) < d) ||
      (road.joins !== undefined && total - (along[i] as number) < d);

    const road_ = (x: number, z: number) => surface.at(x, z).road;
    const curb = (x: number, z: number) => surface.at(x, z).curb;
    strip(road_, pts, ns, (i) => -half(i), half, LIFT);
    for (const side of [-1, 1]) {
      const edge = (i: number) => side * half(i);
      const out = (i: number) => side * (half(i) + 0.45);
      strip(
        curb,
        pts,
        ns,
        side < 0 ? out : edge,
        side < 0 ? edge : out,
        LIFT + 0.02,
        (i) => !meets(i, 10),
      );
      const line0 = (i: number) => side * (half(i) - 0.35);
      const line1 = (i: number) => side * (half(i) - 0.2);
      strip(
        (x, z) => paint.at(x, z).white,
        pts,
        ns,
        side < 0 ? line0 : line1,
        side < 0 ? line1 : line0,
        LIFT + PAINT,
        (i) => !meets(i, 14),
      );
      // The double yellow centre line.
      const mid0 = () => side * 0.08;
      const mid1 = () => side * 0.2;
      strip(
        (x, z) => paint.at(x, z).yellow,
        pts,
        ns,
        side < 0 ? mid1 : mid0,
        side < 0 ? mid0 : mid1,
        LIFT + PAINT,
        (i) => !meets(i, 14) && (along[i] as number) > TAPER && total - (along[i] as number) > 2,
      );
    }
  }

  // Guard rails: a beam on posts every 4 m along each rail's line.
  for (const rail of city.guardRails) {
    const pts = rail.points;
    const ns = normals(pts);
    const at = (x: number, z: number) => rails.at(x, z).rail;
    const [y0, y1] = [RAIL_HEIGHT - 0.32, RAIL_HEIGHT];
    // The beam's two faces, then its top.
    for (const c of [-0.06, 0.06]) {
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1] as RampPoint;
        const b = pts[i] as RampPoint;
        const [na, nb] = [ns[i - 1] as [number, number], ns[i] as [number, number]];
        const q = [
          { x: a.x + na[0] * c, y: a.y + y0, z: a.z + na[1] * c },
          { x: b.x + nb[0] * c, y: b.y + y0, z: b.z + nb[1] * c },
          { x: b.x + nb[0] * c, y: b.y + y1, z: b.z + nb[1] * c },
          { x: a.x + na[0] * c, y: a.y + y1, z: a.z + na[1] * c },
        ] as const;
        const out = { x: na[0] * Math.sign(c), y: 0, z: na[1] * Math.sign(c) };
        const g = at((a.x + b.x) / 2, (a.z + b.z) / 2);
        // Wound to face away from the beam.
        if (c > 0) g.quad(q[0], q[1], q[2], q[3], out, [0, 0, 1, 0, 1, 1, 0, 1]);
        else g.quad(q[1], q[0], q[3], q[2], out, [0, 0, 1, 0, 1, 1, 0, 1]);
      }
    }
    strip(
      at,
      pts,
      ns,
      () => -0.06,
      () => 0.06,
      y1,
    );
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i] as RampPoint;
      at(p.x, p.z).box(
        p.x - 0.07,
        p.y - 0.3,
        p.z - 0.07,
        p.x + 0.07,
        p.y + RAIL_HEIGHT - 0.05,
        p.z + 0.07,
        1,
      );
    }
  }

  const lines = (color: number) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.75,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
  return [
    surface.build(
      {
        road: { material: m.road, name: 'hill-roads' },
        curb: { material: m.curb, name: 'hill-curbs' },
      },
      far,
      'hill-roads',
    ),
    paint.build(
      {
        white: { material: lines(0xe9e6df), name: 'hill-paint-white' },
        yellow: { material: lines(0xd9a623), name: 'hill-paint-yellow' },
      },
      near,
      'hill-markings',
    ),
    rails.build(
      { rail: { material: m.rail, name: 'guard-rails', cast: true } },
      near,
      'guard-rails',
    ),
  ];
}
