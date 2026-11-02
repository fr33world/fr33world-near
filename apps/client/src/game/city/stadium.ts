/**
 * The stadium on Stadium Hill (landmarks.ts `stadium`): an oval bowl, closed all round. Outside,
 * a pale concrete facade with white piers and a dark concourse band that glows at night, under
 * a white roof canopy ring; inside, two tiers of seating in blue sections split by grey aisles,
 * round a striped pitch with its lines; four light towers on the diagonals whose banks light
 * up at night; parking round it on its lot. Merged per material, a handful of draw calls.
 */
import type { CityLayout } from '@fr33world/city';
import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';

const SLAB_Y = 0.15;
/** Segments round the oval. */
const N = 96;
/** The pitch (m) and the oval round it the stands start from. */
const PITCH = { w: 105, d: 68 };
const FIELD = { rx: 76, rz: 51 };
/** The lower tier's top and the upper tier's foot (a concourse between them). */
const LOWER_TOP = 10;
const UPPER_FOOT = 12;
/** Seat rows per tier (each drawn as a band, alternate ones darker). */
const ROWS = 18;
/** The canopy: how far in it reaches over the upper tier and how high it rides (m). */
const CANOPY_IN = 20;
const CANOPY_RISE = 5;

type Glow = (
  color: number,
  strength: number,
  opts?: THREE.MeshStandardMaterialParameters,
) => THREE.MeshStandardMaterial;

export function buildStadium(city: CityLayout, glow: Glow): THREE.Group {
  const st = city.landmarks.stadium;
  const group = new THREE.Group();
  group.name = 'stadium';
  const colour = new THREE.Color();
  const tinted = () => new GeoBuilder().attribute('color', 3, [1, 1, 1]);
  const concrete = tinted();
  const seats = tinted();
  const field = tinted();
  const canopy = new GeoBuilder();
  const lit = new GeoBuilder();
  const banks = new GeoBuilder();
  const lines = new GeoBuilder();
  const parking = new GeoBuilder();
  const up = { x: 0, y: 1, z: 0 };

  /** A point on the oval scaled to half-widths (ax, az), at height y, at segment i. */
  const P = (i: number, ax: number, az: number, y: number) => {
    const a = (i / N) * Math.PI * 2;
    return { x: st.x + Math.cos(a) * ax, y, z: st.z + Math.sin(a) * az };
  };
  /** Outward normal of the oval at segment i (horizontal). */
  const out = (i: number) => {
    const a = (i / N) * Math.PI * 2;
    const n = new THREE.Vector3(Math.cos(a) / st.rx, 0, Math.sin(a) / st.rz);
    return n.normalize();
  };
  /** A vertical band of wall round the oval at half-widths (ax, az), facing out (or in). */
  const wall = (g: GeoBuilder, ax: number, az: number, y0: number, y1: number, inward = false) => {
    for (let i = 0; i < N; i += 1) {
      const [a0, a1, b1, b0] = [
        P(i, ax, az, y0),
        P(i + 1, ax, az, y0),
        P(i + 1, ax, az, y1),
        P(i, ax, az, y1),
      ];
      const n = out(i + 0.5);
      const uv: [number, number, number, number, number, number, number, number] = [
        0, 0, 1, 0, 1, 1, 0, 1,
      ];
      // Seen from outside, increasing angle runs to the left: wound to face out (or in).
      if (inward) g.quad(a0, a1, b1, b0, n.clone().negate(), uv);
      else g.quad(a1, a0, b0, b1, n, uv);
    }
  };
  /**
   * A ring surface between ovals (ax0, az0) at y0 and (ax1, az1) at y1 (inner to outer), facing
   * up; `tint(i)` colours each segment.
   */
  const ring = (
    g: GeoBuilder,
    ax0: number,
    az0: number,
    y0: number,
    ax1: number,
    az1: number,
    y1: number,
    tint?: (i: number) => number,
  ) => {
    for (let i = 0; i < N; i += 1) {
      if (tint) g.set('color', colour.setHex(tint(i)).toArray());
      const [a0, a1, b1, b0] = [
        P(i, ax0, az0, y0),
        P(i + 1, ax0, az0, y0),
        P(i + 1, ax1, az1, y1),
        P(i, ax1, az1, y1),
      ];
      // Counter-clockwise from above (angle increases clockwise seen from above).
      g.quad(a0, a1, b1, b0, up, [0, 0, 1, 0, 1, 1, 0, 1]);
    }
  };

  // The facade: concrete base, the concourse band (lit at night), panels, and white piers.
  concrete.set('color', colour.setHex(0xd9d4ca).toArray());
  wall(concrete, st.rx, st.rz, SLAB_Y, 7);
  wall(lit, st.rx - 0.6, st.rz - 0.6, 7, 10);
  concrete.set('color', colour.setHex(0xe6e2da).toArray());
  wall(concrete, st.rx, st.rz, 10, st.height);
  ring(concrete, st.rx - 0.6, st.rz - 0.6, 7, st.rx, st.rz, 7);
  ring(concrete, st.rx, st.rz, 10, st.rx - 0.6, st.rz - 0.6, 10);
  concrete.set('color', colour.setHex(0xf4f2ee).toArray());
  for (let i = 0; i < N; i += 4) {
    const p = P(i, st.rx + 0.4, st.rz + 0.4, 0);
    concrete.box(p.x - 0.7, SLAB_Y, p.z - 0.7, p.x + 0.7, st.height + 1, p.z + 0.7, 2);
  }

  // The stands: a lower and an upper tier rising from the pitch to the rim, in rows.
  const rimX = st.rx - 2.5;
  const rimZ = st.rz - 2.5;
  const midX = FIELD.rx + (rimX - FIELD.rx) * 0.48;
  const midZ = FIELD.rz + (rimZ - FIELD.rz) * 0.48;
  const section = (i: number, row: number) => {
    if (i % 12 === 0) return 0x9a9c9f; // aisles
    const base = Math.floor(i / 12) % 2 === 0 ? 0x2f5f9e : 0x2a548c;
    return row % 2 === 0 ? base : 0x23466f;
  };
  const tier = (ax0: number, az0: number, y0: number, ax1: number, az1: number, y1: number) => {
    for (let row = 0; row < ROWS; row += 1) {
      const t0 = row / ROWS;
      const t1 = (row + 1) / ROWS;
      ring(
        seats,
        ax0 + (ax1 - ax0) * t0,
        az0 + (az1 - az0) * t0,
        y0 + (y1 - y0) * t0,
        ax0 + (ax1 - ax0) * t1,
        az0 + (az1 - az0) * t1,
        y0 + (y1 - y0) * t1,
        (i) => section(i, row),
      );
    }
  };
  // A low wall round the pitch, the tiers, the concourse face between them, the rim's top.
  concrete.set('color', colour.setHex(0xcfcac0).toArray());
  wall(concrete, FIELD.rx, FIELD.rz, SLAB_Y, 1.6, true);
  tier(FIELD.rx, FIELD.rz, 1.6, midX, midZ, LOWER_TOP);
  wall(concrete, midX, midZ, LOWER_TOP, UPPER_FOOT, true);
  tier(midX, midZ, UPPER_FOOT, rimX, rimZ, st.height - 1);
  ring(concrete, rimX, rimZ, st.height - 1, st.rx, st.rz, st.height);

  // The canopy: a white ring from the facade's top in over the upper tier, rising slightly.
  const cx0 = st.rx - CANOPY_IN;
  const cz0 = st.rz - CANOPY_IN;
  const cy = st.height + 1;
  ring(canopy, cx0, cz0, cy + CANOPY_RISE, st.rx + 1, st.rz + 1, cy);
  for (let i = 0; i < N; i += 1) {
    const [a0, a1, b1, b0] = [
      P(i, cx0, cz0, cy + CANOPY_RISE - 0.3),
      P(i + 1, cx0, cz0, cy + CANOPY_RISE - 0.3),
      P(i + 1, st.rx + 1, st.rz + 1, cy - 0.3),
      P(i, st.rx + 1, st.rz + 1, cy - 0.3),
    ];
    canopy.quad(a0, b0, b1, a1, { x: 0, y: -1, z: 0 }, [0, 0, 1, 0, 1, 1, 0, 1]);
  }
  wall(canopy, cx0, cz0, cy + CANOPY_RISE - 0.3, cy + CANOPY_RISE, true);

  // The pitch: mown stripes across it, in strips cut to the oval (2.5 m wide, so its edge is
  // smooth), and its lines.
  const stripe = 7.5;
  const half = (x: number) => FIELD.rz * Math.sqrt(Math.max(0, 1 - (x / FIELD.rx) ** 2));
  for (let x = -FIELD.rx; x < FIELD.rx - 1e-6; x += 2.5) {
    const x1 = Math.min(FIELD.rx, x + 2.5);
    const [h0, h1] = [half(x), half(x1)];
    const band = Math.floor((x + 1.25 + PITCH.w) / stripe) % 2;
    field.set('color', colour.setHex(band ? 0x4f8f3a : 0x467f33).toArray());
    const y = SLAB_Y + 0.02;
    const V = (vx: number, vz: number) => ({ x: st.x + vx, y, z: st.z + vz });
    field.quad(V(x, h0), V(x1, h1), V(x1, -h1), V(x, -h0), up, [
      x / 3,
      h0 / 3,
      x1 / 3,
      h1 / 3,
      x1 / 3,
      -h1 / 3,
      x / 3,
      -h0 / 3,
    ]);
  }
  const lineY = SLAB_Y + 0.04;
  const hw = PITCH.w / 2;
  const hd = PITCH.d / 2;
  const line = (x0: number, z0: number, x1: number, z1: number) =>
    lines.flat(
      st.x + Math.min(x0, x1) - 0.06,
      st.z + Math.min(z0, z1) - 0.06,
      st.x + Math.max(x0, x1) + 0.06,
      st.z + Math.max(z0, z1) + 0.06,
      lineY,
      1,
    );
  line(-hw, -hd, hw, -hd);
  line(-hw, hd, hw, hd);
  line(-hw, -hd, -hw, hd);
  line(hw, -hd, hw, hd);
  line(0, -hd, 0, hd);
  for (const s of [-1, 1]) {
    // Penalty and goal areas.
    line(s * hw, -20.15, s * (hw - 16.5), -20.15);
    line(s * hw, 20.15, s * (hw - 16.5), 20.15);
    line(s * (hw - 16.5), -20.15, s * (hw - 16.5), 20.15);
    line(s * hw, -9.16, s * (hw - 5.5), -9.16);
    line(s * hw, 9.16, s * (hw - 5.5), 9.16);
    line(s * (hw - 5.5), -9.16, s * (hw - 5.5), 9.16);
  }
  for (let k = 0; k < 48; k += 1) {
    // The centre circle, in short pieces.
    const a = (k / 48) * Math.PI * 2;
    const [x, z] = [Math.cos(a) * 9.15, Math.sin(a) * 9.15];
    lines.flat(st.x + x - 0.35, st.z + z - 0.35, st.x + x + 0.35, st.z + z + 0.35, lineY, 1);
  }

  // Light towers: a mast, a frame and a bank of lamps turned towards the pitch.
  for (const t of st.towers) {
    concrete.set('color', colour.setHex(0xb9bdc2).toArray());
    concrete.box(t.x - 0.6, SLAB_Y, t.z - 0.6, t.x + 0.6, t.height, t.z + 0.6, 2);
    const toward = new THREE.Vector3(st.x - t.x, 0, st.z - t.z).normalize();
    const side = new THREE.Vector3(-toward.z, 0, toward.x);
    const c = new THREE.Vector3(t.x, t.height + 2.5, t.z).addScaledVector(toward, 0.8);
    const corner = (s: number, v: number) =>
      c
        .clone()
        .addScaledVector(side, s * 4)
        .add({ x: 0, y: v * 2.5, z: 0 });
    const n = toward.clone();
    banks.quad(
      corner(1, -1),
      corner(-1, -1),
      corner(-1, 1),
      corner(1, 1),
      n,
      [0, 0, 1, 0, 1, 1, 0, 1],
    );
    concrete.box(c.x - 0.3, t.height, c.z - 0.3, c.x + 0.3, t.height + 5, c.z + 0.3, 2);
  }

  // Parking round it: asphalt over the lot, rows of bays in its four corners.
  const lot = st.lot;
  parking.flat(lot.x0 + 2, lot.z0 + 2, lot.x1 - 2, lot.z1 - 2, SLAB_Y + 0.01, 6);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const x0 = sx < 0 ? lot.x0 + 6 : lot.x1 - 36;
    const z0 = sz < 0 ? lot.z0 + 6 : lot.z1 - 22;
    for (const rowZ of [z0, z0 + 11]) {
      for (let x = x0; x <= x0 + 30; x += 2.7) {
        lines.flat(x - 0.06, rowZ, x + 0.06, rowZ + 5, SLAB_Y + 0.03, 1);
      }
    }
  }

  const plain = (opts: THREE.MeshStandardMaterialParameters) =>
    new THREE.MeshStandardMaterial(opts);
  const add = (g: GeoBuilder, material: THREE.Material, name: string, cast: boolean) => {
    if (g.vertexCount === 0) return;
    const mesh = new THREE.Mesh(g.build(), material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  };
  add(concrete, plain({ vertexColors: true, roughness: 0.85 }), 'stadium-structure', true);
  add(
    seats,
    plain({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }),
    'stadium-seats',
    false,
  );
  add(canopy, plain({ color: 0xf2f2ef, roughness: 0.5, metalness: 0.2 }), 'stadium-canopy', true);
  // The pitch glows a little at night (the floodlights on it).
  add(
    field,
    glow(0xffffff, 0.12, {
      vertexColors: true,
      roughness: 0.9,
      emissive: 0x2f6a26,
      // Over the parking's asphalt, which runs under the whole lot.
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    }),
    'stadium-pitch',
    false,
  );
  add(
    lines,
    plain({
      color: 0xf1f1ec,
      roughness: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -7,
      polygonOffsetUnits: -7,
    }),
    'stadium-lines',
    false,
  );
  add(lit, glow(0x3a3632, 1.2, { emissive: 0xffd9a0, roughness: 0.6 }), 'stadium-concourse', false);
  add(
    banks,
    glow(0xdfe6ea, 4, { emissive: 0xffffff, side: THREE.DoubleSide }),
    'stadium-lamps',
    false,
  );
  add(
    parking,
    plain({ color: 0x4b4b4d, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3 }),
    'stadium-parking',
    false,
  );
  return group;
}
