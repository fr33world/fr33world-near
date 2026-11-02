/**
 * The landmarks (packages/city/src/landmarks.ts): city hall's crown, the observatory's domes,
 * the hillside sign, the pier with its Ferris wheel, and the stadium (stadium.ts). City hall's and the observatory's
 * walls are drawn with the other buildings (city.ts). Everything here is merged per material;
 * the wheel turns slowly (its cars stay level) and, with the sign and city hall's beacon,
 * lights up at night. Textures are painted on canvases at start-up (nothing to download).
 */
import { type CityLayout, PIER, type Rect, terrainHeight } from '@fr33world/city';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoBuilder } from './geo.ts';
import { buildStadium } from './stadium.ts';

const SLAB_Y = 0.15;
/** One turn of the wheel (s). */
const WHEEL_TURN = 180;
const WHEEL_CARS = 20;

export interface LandmarksView {
  group: THREE.Group;
  /** Night factor (0 day … 1 night); the wheel's angle follows the clock. */
  update(night: number): void;
}

export function buildLandmarks(city: CityLayout): LandmarksView {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const lit: { material: THREE.MeshStandardMaterial; strength: number }[] = [];
  const glow = (
    color: number,
    strength: number,
    opts: THREE.MeshStandardMaterialParameters = {},
  ) => {
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0,
      ...opts,
    });
    lit.push({ material, strength });
    return material;
  };

  cityHallCrown(group, city, glow);
  observatoryDomes(group, city);
  hillsideSign(group, city, glow);
  pier(group);
  const wheel = ferrisWheel(group, city, glow);
  group.add(buildStadium(city, glow));

  return {
    group,
    update(night: number) {
      for (const { material, strength } of lit) material.emissiveIntensity = night * strength;
      wheel.turn(((performance.now() / 1000) % WHEEL_TURN) / WHEEL_TURN);
    },
  };
}

type Glow = (
  color: number,
  strength: number,
  opts?: THREE.MeshStandardMaterialParameters,
) => THREE.MeshStandardMaterial;

function add(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
  cast = true,
) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/** A square beam from `a` to `b`. */
function beam(a: THREE.Vector3, b: THREE.Vector3, thickness: number): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const g = new THREE.BoxGeometry(thickness, dir.length(), thickness);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

/** City hall: stepped set-backs, a pyramid and a mast with a red beacon over the tower. */
function cityHallCrown(group: THREE.Group, city: CityLayout, glow: Glow) {
  const { x, z, side, top } = city.landmarks.cityHall;
  const stone = new THREE.MeshStandardMaterial({ color: 0xc9c1b0, roughness: 0.9 });
  const parts: THREE.BufferGeometry[] = [];
  const tier = (s: number, y0: number, h: number) =>
    parts.push(new THREE.BoxGeometry(s, h, s).translate(x, y0 + h / 2, z));
  tier(side * 0.82, top, 7);
  tier(side * 0.64, top + 7, 6);
  // A four-sided pyramid (cone with four segments, turned to sit square on the tier below).
  const pyramid = new THREE.ConeGeometry(side * 0.64 * Math.SQRT1_2, 16, 4, 1)
    .rotateY(Math.PI / 4)
    .translate(x, top + 13 + 8, z);
  parts.push(pyramid);
  parts.push(new THREE.CylinderGeometry(0.25, 0.4, 10, 8).translate(x, top + 29 + 5, z));
  add(group, mergeGeometries(parts), stone, 'city-hall-crown');
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 12, 8),
    glow(0xff2a1a, 4, { roughness: 0.4 }),
  );
  beacon.position.set(x, top + 39.4, z);
  group.add(beacon);
}

/** The observatory: a big central dome on a drum and two smaller ones at the ends. */
function observatoryDomes(group: THREE.Group, city: CityLayout) {
  const { x, z, roof, length } = city.landmarks.observatory;
  const copper = new THREE.MeshStandardMaterial({
    color: 0x7f948a,
    roughness: 0.55,
    metalness: 0.6,
  });
  const drumStone = new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.9 });
  const domes: THREE.BufferGeometry[] = [];
  const drums: THREE.BufferGeometry[] = [];
  for (const [dx, r, drum] of [
    [0, 9, 4],
    [-length / 2 + 7, 4.5, 2],
    [length / 2 - 7, 4.5, 2],
  ] as const) {
    drums.push(new THREE.CylinderGeometry(r, r, drum, 32).translate(x + dx, roof + drum / 2, z));
    domes.push(
      new THREE.SphereGeometry(r * 1.02, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2).translate(
        x + dx,
        roof + drum,
        z,
      ),
    );
  }
  add(group, mergeGeometries(drums), drumStone, 'observatory-drums');
  add(group, mergeGeometries(domes), copper, 'observatory-domes');
}

/** The sign's letters as cut-out sheet panels (one canvas atlas), on steel scaffolding. */
function hillsideSign(group: THREE.Group, city: CityLayout, glow: Glow) {
  const { z, height, letters } = city.landmarks.sign;
  const chars = [...new Set(letters.map((l) => l.char))];
  const CW = 256;
  const CH = Math.round((CW * height) / (letters[0]?.w ?? 10));
  const canvas = document.createElement('canvas');
  canvas.width = CW * chars.length;
  canvas.height = CH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.fillStyle = '#ffffff';
  chars.forEach((char, i) => {
    ctx.save();
    ctx.font = `900 200px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    const m = ctx.measureText(char);
    const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    // Stretch each glyph to fill its panel, as the real sheet letters are cut.
    const pad = 6;
    ctx.translate(i * CW + pad, pad);
    ctx.scale((CW - 2 * pad) / w, (CH - 2 * pad) / h);
    ctx.fillText(char, m.actualBoundingBoxLeft, m.actualBoundingBoxAscent);
    ctx.restore();
  });
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;

  const panels = new GeoBuilder();
  const steel: THREE.BufferGeometry[] = [];
  const lift = 1.5;
  for (const l of letters) {
    const i = chars.indexOf(l.char);
    const u0 = i / chars.length;
    const u1 = (i + 1) / chars.length;
    const x0 = l.x - l.w / 2;
    const x1 = l.x + l.w / 2;
    // Each letter stands on the slope under it (layout `y`), posts into the hillside.
    const y0 = l.y + lift;
    const y1 = y0 + height;
    panels.quad(
      { x: x0, y: y0, z },
      { x: x1, y: y0, z },
      { x: x1, y: y1, z },
      { x: x0, y: y1, z },
      { x: 0, y: 0, z: 1 },
      [u0, 0, u1, 0, u1, 1, u0, 1],
    );
    const v = (x: number, y: number, dz: number) => new THREE.Vector3(x, y, z + dz);
    for (const px of [x0 + 1.2, l.x, x1 - 1.2]) {
      steel.push(
        beam(v(px, terrainHeight(px, z - 0.6) - 0.5, -0.6), v(px, y1, -0.6), 0.25),
        beam(v(px, terrainHeight(px, z - 6) - 0.3, -6), v(px, y0 + height * 0.7, -0.6), 0.2),
      );
    }
    for (const t of [0.35, 0.8]) {
      steel.push(beam(v(x0, y0 + height * t, -0.6), v(x1, y0 + height * t, -0.6), 0.2));
    }
  }
  const face = glow(0xffffff, 0.5, {
    map: atlas,
    emissiveMap: atlas,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.6,
  });
  add(group, panels.build(), face, 'sign-letters');
  add(
    group,
    mergeGeometries(steel),
    new THREE.MeshStandardMaterial({ color: 0x5a5d60, roughness: 0.6, metalness: 0.5 }),
    'sign-scaffold',
  );
}

/** Boards running across the deck (a canvas texture, 4 m per repeat). */
function boardsTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const boards = 16;
  for (let i = 0; i < boards; i += 1) {
    const shade = 120 + Math.floor(Math.random() * 30);
    ctx.fillStyle = `rgb(${shade + 22}, ${shade + 4}, ${shade - 20})`;
    ctx.fillRect((i * 256) / boards, 0, 256 / boards, 256);
    ctx.fillStyle = 'rgba(40, 30, 20, 0.55)';
    ctx.fillRect(((i + 1) * 256) / boards - 1.5, 0, 1.5, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** The pier: a timber deck on piles, railings along the water's edge. */
function pier(group: THREE.Group) {
  const deck = new GeoBuilder();
  const timber: THREE.BufferGeometry[] = [];
  for (const p of PIER) {
    deck.box(p.x0, -0.35, p.z0, p.x1, SLAB_Y, p.z1, 4);
    // Piles every 8 m along the edges (and down the middle of the platform).
    const rows = p.z1 - p.z0 > 30 ? [p.z0 + 1, (p.z0 + p.z1) / 2, p.z1 - 1] : [p.z0 + 1, p.z1 - 1];
    for (let x = p.x0 + 2; x < p.x1; x += 8) {
      for (const pz of rows) timber.push(new THREE.BoxGeometry(0.7, 6, 0.7).translate(x, -3.3, pz));
    }
  }
  // Railings over the water: along each piece's sides, except where pieces meet.
  const [neck, platform, end] = PIER as [Rect, Rect, Rect];
  const coast = -1263;
  const rails: [number, number, number, number][] = [
    [coast, neck.z0, neck.x0, neck.z0],
    [coast, neck.z1, neck.x0, neck.z1],
    [platform.x1, platform.z0, platform.x1, neck.z0],
    [platform.x1, neck.z1, platform.x1, platform.z1],
    [platform.x0, platform.z0, platform.x1, platform.z0],
    [platform.x0, platform.z1, platform.x1, platform.z1],
    [platform.x0, platform.z0, platform.x0, end.z0],
    [platform.x0, end.z1, platform.x0, platform.z1],
    [end.x0, end.z0, end.x1, end.z0],
    [end.x0, end.z1, end.x1, end.z1],
    [end.x0, end.z0, end.x0, end.z1],
  ];
  for (const [ax, az, bx, bz] of rails) {
    const a = new THREE.Vector3(ax, SLAB_Y + 1.05, az);
    const b = new THREE.Vector3(bx, SLAB_Y + 1.05, bz);
    timber.push(beam(a, b, 0.12));
    timber.push(beam(a.clone().setY(SLAB_Y + 0.5), b.clone().setY(SLAB_Y + 0.5), 0.07));
    const len = a.distanceTo(b);
    for (let t = 0; t <= len; t += 3) {
      const p = a.clone().lerp(b, t / len);
      timber.push(new THREE.BoxGeometry(0.12, 1.05, 0.12).translate(p.x, SLAB_Y + 0.52, p.z));
    }
  }
  add(
    group,
    deck.build(),
    new THREE.MeshStandardMaterial({ map: boardsTexture(), roughness: 0.9 }),
    'pier-deck',
  );
  add(
    group,
    mergeGeometries(timber),
    new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 0.85 }),
    'pier-timber',
  );
}

/** The Ferris wheel: two rims, spokes and cross bars turning on A-frame legs; level cars. */
function ferrisWheel(group: THREE.Group, city: CityLayout, glow: Glow) {
  const { x, z, hubY, radius: R } = city.landmarks.wheel;
  const root = new THREE.Group();
  root.name = 'ferris-wheel';
  // Built with the axle along local z; turned so the axle runs along world x (the wheel faces
  // the city down Grand Avenue).
  root.position.set(x, hubY, z);
  root.rotation.y = Math.PI / 2;
  group.add(root);

  const white = new THREE.MeshStandardMaterial({ color: 0xf0f0ec, roughness: 0.5, metalness: 0.4 });
  const legs: THREE.BufferGeometry[] = [];
  for (const side of [-2.5, 2.5]) {
    for (const spread of [-14, 14]) {
      legs.push(
        beam(new THREE.Vector3(0, 0, side), new THREE.Vector3(spread, SLAB_Y - hubY, side), 0.7),
      );
    }
    legs.push(
      beam(new THREE.Vector3(-7, -hubY / 2, side), new THREE.Vector3(7, -hubY / 2, side), 0.4),
    );
  }
  legs.push(new THREE.CylinderGeometry(0.9, 0.9, 6.5, 16).rotateX(Math.PI / 2));
  add(root, mergeGeometries(legs), white, 'wheel-legs');

  const wheel = new THREE.Group();
  root.add(wheel);
  const frame: THREE.BufferGeometry[] = [];
  const SPOKES = 16;
  for (const side of [-1.6, 1.6]) {
    for (let i = 0; i < SPOKES; i += 1) {
      const a = (i / SPOKES) * Math.PI * 2;
      const rim = new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, side);
      frame.push(beam(new THREE.Vector3(0, 0, side * 1.6), rim, 0.22));
      const a2 = ((i + 1) / SPOKES) * Math.PI * 2;
      // Bracing between neighbouring spokes, half way out.
      frame.push(
        beam(
          new THREE.Vector3(Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55, side),
          new THREE.Vector3(Math.cos(a2) * R * 0.55, Math.sin(a2) * R * 0.55, side),
          0.15,
        ),
      );
    }
  }
  for (let i = 0; i < WHEEL_CARS; i += 1) {
    const a = (i / WHEEL_CARS) * Math.PI * 2;
    frame.push(
      beam(
        new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, -1.6),
        new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 1.6),
        0.2,
      ),
    );
  }
  add(wheel, mergeGeometries(frame), white, 'wheel-frame');
  const rims = mergeGeometries([
    new THREE.TorusGeometry(R, 0.3, 6, 96).translate(0, 0, -1.6),
    new THREE.TorusGeometry(R, 0.3, 6, 96).translate(0, 0, 1.6),
  ]);
  // The rims carry the lights: white by day, glowing at night.
  add(wheel, rims, glow(0xfff1d6, 2.2, { roughness: 0.4, metalness: 0.3 }), 'wheel-rims');

  // Cars hang under the rim and stay level as it turns.
  const carGeo = mergeGeometries([
    new THREE.BoxGeometry(2.2, 1.9, 2.4).translate(0, -1.9, 0),
    new THREE.BoxGeometry(2.5, 0.25, 2.7).translate(0, -0.85, 0),
  ]);
  const cars = new THREE.InstancedMesh(
    carGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 }),
    WHEEL_CARS,
  );
  cars.name = 'wheel-cars';
  cars.castShadow = true;
  // The cars move every frame; three.js computes an instanced mesh's bounds only once.
  cars.frustumCulled = false;
  const palette = [0xd9483b, 0xf2c14e, 0x2f7dbf, 0x2f9d6a];
  const colour = new THREE.Color();
  for (let i = 0; i < WHEEL_CARS; i += 1) {
    cars.setColorAt(i, colour.setHex(palette[i % palette.length] ?? 0xffffff));
  }
  root.add(cars);
  const m = new THREE.Matrix4();

  return {
    turn(t: number) {
      const angle = t * Math.PI * 2;
      wheel.rotation.z = angle;
      for (let i = 0; i < WHEEL_CARS; i += 1) {
        const a = angle + (i / WHEEL_CARS) * Math.PI * 2;
        m.makeTranslation(Math.cos(a) * R, Math.sin(a) * R, 0);
        cars.setMatrixAt(i, m);
      }
      cars.instanceMatrix.needsUpdate = true;
    },
  };
}
