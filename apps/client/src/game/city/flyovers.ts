/**
 * The interchange's connectors and the freeways' descents (layout `ramps`, ramps.ts): an
 * asphalt slab on concrete, barriers along both sides (open where a connector runs onto a
 * deck), edge lines, columns down to the ground (or the river channel's floor), and on the
 * descents the deck's centre barrier and lane lines. Physics matches in physics.ts.
 */
import { type CityLayout, onDeck, type Ramp, type RampPoint, terrainHeight } from '@fr33world/city';
import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';

/** Lifted off the decks it shares an edge with (no flicker where the two overlap). */
const LIFT = 0.03;

/** Horizontal unit normals (left of travel) at each point, averaged at the joints. */
function normals(pts: RampPoint[]): [number, number][] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)] as RampPoint;
    const b = pts[Math.min(pts.length - 1, i + 1)] as RampPoint;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const n = Math.hypot(dx, dz) || 1;
    return [-dz / n, dx / n];
  });
}

/**
 * A band along the ramp between offsets c0 and c1 (from the centreline), from `y0` to `y1`
 * above its surface: top, both sides and (when `bottom`) the underside.
 */
function band(
  g: GeoBuilder,
  pts: RampPoint[],
  ns: [number, number][],
  c0: number,
  c1: number,
  y0: number,
  y1: number,
  keep: (i: number) => boolean,
  faces: { top: boolean; sides: boolean; bottom: boolean },
) {
  const at = (i: number, c: number, dy: number) => {
    const p = pts[i] as RampPoint;
    const [nx, nz] = ns[i] as [number, number];
    return new THREE.Vector3(p.x + nx * c, p.y + dy, p.z + nz * c);
  };
  let along = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1] as RampPoint;
    const b = pts[i] as RampPoint;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const u0 = along / 8;
    const u1 = (along + len) / 8;
    along += len;
    if (!keep(i)) continue;
    const up = new THREE.Vector3(0, 1, 0);
    if (faces.top) {
      // Counter-clockwise from above: c0 → c1 at the start, then back at the end.
      g.quad(at(i - 1, c0, y1), at(i - 1, c1, y1), at(i, c1, y1), at(i, c0, y1), up, [
        c0 / 8,
        u0,
        c1 / 8,
        u0,
        c1 / 8,
        u1,
        c0 / 8,
        u1,
      ]);
    }
    if (faces.bottom) {
      g.quad(
        at(i - 1, c1, y0),
        at(i - 1, c0, y0),
        at(i, c0, y0),
        at(i, c1, y0),
        up.clone().negate(),
        [0, 0, 1, 0, 1, 1, 0, 1],
      );
    }
    if (faces.sides) {
      for (const [c, s] of [
        [c0, -1],
        [c1, 1],
      ] as const) {
        const [nx, nz] = ns[i] as [number, number];
        const out = new THREE.Vector3(nx * s, 0, nz * s);
        const q = [at(i - 1, c, y0), at(i, c, y0), at(i, c, y1), at(i - 1, c, y1)] as const;
        // Wound to face away from the band.
        if (s > 0) g.quad(q[0], q[1], q[2], q[3], out, [u0, 0, u1, 0, u1, 1, u0, 1]);
        else g.quad(q[1], q[0], q[3], q[2], out, [u1, 0, u0, 0, u0, 1, u1, 1]);
      }
    }
  }
}

export function buildFlyovers(
  city: CityLayout,
  m: { road: THREE.Material; concrete: THREE.Material },
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'flyovers';
  const surface = new GeoBuilder();
  const concrete = new GeoBuilder();
  const paint = new GeoBuilder();
  const overDeck = (r: Ramp, i: number, c: number) => {
    const a = r.points[i - 1] as RampPoint;
    const b = r.points[i] as RampPoint;
    const ns = normals([a, b]);
    const [nx, nz] = ns[0] as [number, number];
    const mx = (a.x + b.x) / 2 + nx * c;
    const mz = (a.z + b.z) / 2 + nz * c;
    return city.freeways.some((f) => onDeck(f, mx, mz, 0.5));
  };
  for (const r of city.ramps) {
    const pts = r.points.map((p) => ({ ...p, y: p.y + LIFT }));
    const ns = normals(pts);
    const half = r.width / 2;
    const all = () => true;
    band(surface, pts, ns, -half, half, 0, 0, all, { top: true, sides: false, bottom: false });
    band(concrete, pts, ns, -half, half, -r.depth, -0.01, all, {
      top: false,
      sides: true,
      bottom: true,
    });
    for (const side of [-1, 1]) {
      const c0 = side < 0 ? -half : half - 0.5;
      const c1 = c0 + 0.5;
      band(concrete, pts, ns, c0, c1, 0, 0.9, (i) => !overDeck(r, i, side * (half - 0.25)), {
        top: true,
        sides: true,
        bottom: false,
      });
      // Edge lines, inside the barriers.
      const e0 = side < 0 ? -half + 0.7 : half - 0.85;
      band(paint, pts, ns, e0, e0 + 0.15, 0, 0.012, all, {
        top: true,
        sides: false,
        bottom: false,
      });
    }
    if (r.kind === 'descent') {
      // The deck's centre barrier and dashed lane lines carry on down to the street.
      band(concrete, pts, ns, -0.3, 0.3, 0, 0.85, all, { top: true, sides: true, bottom: false });
      const dashed = (i: number) => i % 2 === 1;
      for (const side of [-1, 1]) {
        for (let lane = 1; lane < 3; lane += 1) {
          const c = side * (0.6 + lane * 3.6);
          band(paint, pts, ns, c - 0.07, c + 0.07, 0, 0.012, dashed, {
            top: true,
            sides: false,
            bottom: false,
          });
        }
      }
    }
    for (const p of r.pillars) {
      const foot = Math.min(-0.02, terrainHeight(p.x, p.z));
      concrete.box(
        p.x - p.w / 2,
        foot,
        p.z - p.d / 2,
        p.x + p.w / 2,
        p.top + LIFT,
        p.z + p.d / 2,
        2,
      );
      // A cap under the slab.
      const cap = r.kind === 'descent' ? 3 : 2.2;
      concrete.box(p.x - cap, p.top - 0.8, p.z - cap, p.x + cap, p.top + LIFT, p.z + cap, 2);
    }
  }
  const lines = new THREE.MeshStandardMaterial({
    color: 0xe9e6df,
    roughness: 0.75,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  for (const [g, material, name, cast] of [
    [surface, m.road, 'ramp-surface', false],
    [concrete, m.concrete, 'ramp-structure', true],
    [paint, lines, 'ramp-lines', false],
  ] as const) {
    if (g.vertexCount === 0) continue;
    const mesh = new THREE.Mesh(g.build(), material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  return group;
}
