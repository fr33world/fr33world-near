/**
 * Car Dealership, the dealership (city `dealership`): its forecourt in pale paving with the
 * delivery bays painted on it, a pylon sign at the boulevard and the name on the showroom's
 * roof slab (both lit at night), a price board in front of every car on show, and at the
 * showroom's door the sales desk's marker, like a car park's but gold with a $. The cars on
 * show are the world server's (parked, nobody may drive them); the showroom is a building.
 * Seven draw calls in all.
 */
import { type CityLayout, type Dealership, lotHeight } from '@fr33world/city';
import { CAR_MODELS, CARS_FOR_SALE, DEALER_MODELS } from '@fr33world/shared';
import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';
import { beamTexture, MARKER_RADIUS, markerTexture } from './parking.ts';

const GOLD = 0xffbf3a;
const BAY_W = 2.7;
const BAY_L = 5.4;
const LINE = 0.12;
/** Price boards: size, height of their middle, and how far in front of a car's nose. */
const BOARD = { w: 1.1, h: 0.66, y: 0.95, ahead: 0.9 };
/** Beyond this the boards and the desk's marker aren't drawn (m). */
const DETAIL_DISTANCE = 160;

const TITLE_FONT = `'Bebas Neue', 'Arial Narrow', system-ui, sans-serif`;
const TEXT_FONT = `Barlow, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

/** The name, white on deep blue glass with a gold rule, 4:1. */
function drawName(c: HTMLCanvasElement) {
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#16233a');
  grad.addColorStop(1, '#0b1322');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffbf3a';
  g.fillRect(0, c.height - 22, c.width, 10);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `400 168px ${TITLE_FONT}`;
  g.fillText('CAR DEALERSHIP', c.width / 2, c.height / 2 - 6, c.width - 24);
}

/** The price boards: one cell per car on show (name, price), 4 × 3 cells. */
function drawBoards(c: HTMLCanvasElement) {
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const cw = c.width / 4;
  const ch = c.height / 3;
  DEALER_MODELS.forEach((model, i) => {
    const x = (i % 4) * cw;
    const y = Math.floor(i / 4) * ch;
    g.fillStyle = '#ffffff';
    g.fillRect(x, y, cw, ch);
    g.fillStyle = '#0b1322';
    g.fillRect(x, y, cw, ch * 0.18);
    g.fillStyle = '#ffbf3a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `400 ${ch * 0.15}px ${TITLE_FONT}`;
    g.fillText('CAR DEALERSHIP', x + cw / 2, y + ch * 0.095, cw * 0.92);
    g.fillStyle = '#0b1322';
    g.font = `400 ${ch * 0.3}px ${TITLE_FONT}`;
    g.fillText((CAR_MODELS[model]?.name ?? '').toUpperCase(), x + cw / 2, y + ch * 0.42);
    const price = CARS_FOR_SALE[i]?.price ?? 0;
    g.font = `700 ${ch * 0.24}px ${TEXT_FONT}`;
    g.fillText(`$${(price / 100).toLocaleString('en-US')}`, x + cw / 2, y + ch * 0.74);
  });
}

function canvasTexture(w: number, h: number, draw: (c: HTMLCanvasElement) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // Drawn again once the game's fonts are in (asked for here: a canvas alone doesn't load them).
  void Promise.all([
    document.fonts.load(`400 64px 'Bebas Neue'`),
    document.fonts.load('700 64px Barlow'),
  ]).then(
    () => {
      draw(c);
      t.needsUpdate = true;
    },
    () => {},
  );
  return t;
}

/** A vertical rectangle facing `yaw` (its front towards the direction yaw points). */
function panel(
  out: number[],
  uv: number[],
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
  w: number,
  h: number,
  cell: [number, number, number, number] = [0, 0, 1, 1],
) {
  // Right, as seen by someone in front looking at it.
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const p = (u: number, v: number) => [cx + rx * u * w, cy + v * h, cz + rz * u * w];
  const [a, b, c, d] = [p(-0.5, -0.5), p(0.5, -0.5), p(0.5, 0.5), p(-0.5, 0.5)];
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
  const [u0, v0, u1, v1] = cell;
  uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
}

function panelMesh(positions: number[], uvs: number[], material: THREE.Material, name: string) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

export function buildDealership(
  city: CityLayout,
  paving: THREE.Material,
): { group: THREE.Group; update(night: number, eye: THREE.Vector3): void } {
  const group = new THREE.Group();
  group.name = 'dealership';
  const d: Dealership | null = city.dealership;
  if (!d) return { group, update() {} };
  const r = d.rect;
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const y = lotHeight(city, r);

  // The forecourt, and the delivery bays' lines on it.
  const ground = new GeoBuilder();
  ground.flat(r.x0, r.z0, r.x1, r.z1, y, 4);
  const forecourt = new THREE.Mesh(ground.build(), paving);
  forecourt.receiveShadow = true;
  forecourt.name = 'dealer-forecourt';
  const lines: number[] = [];
  const strip = (x: number, z: number, ax: number, az: number, along: number) => {
    const bx = -az * (LINE / 2);
    const bz = ax * (LINE / 2);
    const p = (u: number, s: number) => [x + ax * u + bx * s, y + 0.02, z + az * u + bz * s];
    const [a, b, c, e] = [p(-along / 2, -1), p(along / 2, -1), p(along / 2, 1), p(-along / 2, 1)];
    lines.push(...a, ...c, ...b, ...a, ...e, ...c);
  };
  for (const bay of d.delivery) {
    const fx = Math.sin(bay.yaw);
    const fz = Math.cos(bay.yaw);
    for (const side of [-1, 1])
      strip(bay.x + fz * side * (BAY_W / 2), bay.z - fx * side * (BAY_W / 2), fx, fz, BAY_L);
    strip(bay.x - fx * (BAY_L / 2), bay.z - fz * (BAY_L / 2), -fz, fx, BAY_W);
  }
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  lineGeometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      Array.from({ length: lines.length / 3 }, () => [0, 1, 0]).flat(),
      3,
    ),
  );
  const marks = new THREE.Mesh(
    lineGeometry,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
    }),
  );
  marks.name = 'dealer-lines';

  // The pylon: two steel posts and the name panel, both faces, high over the sidewalk.
  const s = d.sign;
  const steel = new THREE.MeshStandardMaterial({ color: 0x2c333b, metalness: 0.7, roughness: 0.4 });
  const pylon = new GeoBuilder();
  const rx = Math.cos(s.yaw);
  const rz = -Math.sin(s.yaw);
  for (const side of [-1, 1]) {
    const px = s.x + rx * side * 2.1;
    const pz = s.z + rz * side * 2.1;
    pylon.box(px - 0.12, y, pz - 0.12, px + 0.12, y + 7.6, pz + 0.12, 1);
  }
  const posts = new THREE.Mesh(pylon.build(), steel);
  posts.castShadow = true;
  posts.name = 'dealer-pylon';
  const nameTex = canvasTexture(1024, 256, drawName);
  const nameMaterial = new THREE.MeshStandardMaterial({
    map: nameTex,
    emissiveMap: nameTex,
    emissive: 0xffffff,
    emissiveIntensity: 0.2,
    roughness: 0.35,
  });
  const names: number[] = [];
  const nameUv: number[] = [];
  panel(names, nameUv, s.x, y + 6.4, s.z, s.yaw, 5, 1.25);
  // And back to back with it, for the other side of the street.
  const back = { x: s.x - Math.sin(s.yaw) * 0.02, z: s.z - Math.cos(s.yaw) * 0.02 };
  panel(names, nameUv, back.x, y + 6.4, back.z, s.yaw + Math.PI, 5, 1.25);
  // On the showroom's roof slab, facing the street.
  const sh = d.showroom;
  const front = { x: sh.x + Math.sin(s.yaw) * (sh.w / 2 + 0.81), z: sh.z };
  panel(names, nameUv, front.x, y - 0.02 + sh.h - 0.45, front.z, s.yaw, 3.4, 0.85);
  const nameMesh = panelMesh(names, nameUv, nameMaterial, 'dealer-names');

  // A price board in front of each car on show, on a short post, facing the street.
  const boardTex = canvasTexture(1024, 512, drawBoards);
  const boardMaterial = new THREE.MeshStandardMaterial({
    map: boardTex,
    roughness: 0.6,
    emissiveMap: boardTex,
    emissive: 0xffffff,
    emissiveIntensity: 0.05,
  });
  const boards: number[] = [];
  const boardUv: number[] = [];
  const legs = new GeoBuilder();
  d.display.forEach((spot, i) => {
    const model = DEALER_MODELS[i];
    const spec = model === undefined ? undefined : CAR_MODELS[model];
    if (!spec) return;
    const fx = Math.sin(spot.yaw);
    const fz = Math.cos(spot.yaw);
    const bx = spot.x + fx * (spec.length / 2 + BOARD.ahead);
    const bz = spot.z + fz * (spec.length / 2 + BOARD.ahead);
    const col = i % 4;
    const row = Math.floor(i / 4);
    // Canvas rows run down, texture v up.
    panel(boards, boardUv, bx, y + BOARD.y, bz, s.yaw, BOARD.w, BOARD.h, [
      col / 4,
      1 - (row + 1) / 3,
      (col + 1) / 4,
      1 - row / 3,
    ]);
    const lx = bx - Math.sin(s.yaw) * 0.03;
    const lz = bz - Math.cos(s.yaw) * 0.03;
    legs.box(lx - 0.03, y, lz - 0.03, lx + 0.03, y + BOARD.y, lz + 0.03, 1);
  });
  const boardMesh = panelMesh(boards, boardUv, boardMaterial, 'dealer-boards');
  const legMesh = new THREE.Mesh(legs.build(), steel);
  legMesh.name = 'dealer-board-posts';

  // The sales desk's marker: a gold ring round a $ under a beam.
  const floorMaterial = new THREE.MeshBasicMaterial({
    map: markerTexture('$'),
    color: GOLD,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -10,
    polygonOffsetUnits: -10,
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(MARKER_RADIUS * 2, MARKER_RADIUS * 2).rotateX(-Math.PI / 2),
    floorMaterial,
  );
  floor.position.set(d.desk.x, y + 0.04, d.desk.z);
  floor.renderOrder = 2;
  floor.name = 'dealer-marker';
  const beamMaterial = new THREE.MeshBasicMaterial({
    map: beamTexture(),
    color: GOLD,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS, 7, 24, 1, true).translate(0, 3.5, 0),
    beamMaterial,
  );
  beam.position.copy(floor.position);
  beam.renderOrder = 3;

  const details = [boardMesh, legMesh, floor, beam];
  group.add(forecourt, marks, posts, nameMesh, ...details);
  const centre = new THREE.Vector3(cx, y, cz);
  return {
    group,
    update(night: number, eye: THREE.Vector3) {
      nameMaterial.emissiveIntensity = 0.2 + night * 1.1;
      boardMaterial.emissiveIntensity = 0.05 + night * 0.45;
      const near = eye.distanceTo(centre) < DETAIL_DISTANCE;
      for (const m of details) m.visible = near;
      if (!near) return;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 450);
      floorMaterial.opacity = 0.7 + 0.3 * pulse;
      beamMaterial.opacity = 0.55 + 0.25 * pulse + 0.2 * night;
    },
  };
}
