#!/usr/bin/env node
/**
 * The cars (Phase 7): from the Sketchfab downloads in assets/incoming/cars (CC BY 4.0; licences
 * in assets/licenses) to small game models in apps/client/public/assets/cars, one file a car,
 * and their measurements in packages/shared/src/car-models.ts (generated).
 *
 * For each car: its parts are cut out of the download (the generic pack is a showroom of ten
 * cars at odd angles), turned to face +z with the origin on the ground between the axles
 * (the front found from the lights: red lenses are the tail), and regrouped as
 *   body   every part but the wheels and lamps, joined by material (a few draw calls)
 *   head   headlight lenses, tail  brake and reverse lenses (lit by the game)
 *   wheel  one wheel (the front left), centred on its hub; the game places and mirrors four
 * Textures shrink to 1024² for paint, 512² for the rest, then KTX2 (compressed on the GPU);
 * hidden underbody and interior detail is simplified; geometry is meshopt-compressed.
 *
 *   node scripts/assets/cars.mjs
 * Needs KTX-Software (`ktx` on PATH or in ~/.local/ktx-4.4.2; see optimize.mjs).
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Mode, toktx } from '@gltf-transform/cli';
import { getBounds, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  join as joinMeshes,
  meshopt,
  prune,
  simplifyPrimitive,
  textureCompress,
  transformMesh,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../..');
const incoming = join(root, 'assets/incoming/cars');
const out = join(root, 'apps/client/public/assets/cars');
const ktxHome = process.env.KTX_HOME ?? join(process.env.HOME ?? '', '.local/ktx-4.4.2');
if (existsSync(join(ktxHome, 'bin/ktx')))
  process.env.PATH = `${join(ktxHome, 'bin')}:${process.env.PATH}`;

/** Every car: where it comes from, how its parts are named there, and how it drives. */
const PACK = 'generic_passenger_car_pack.glb';
/**
 * The pack's cars are modelled small (its sedan stood 1.2 m tall, its compact 3.3 m long):
 * beside a person and behind the driving camera they looked like toys (owner, 2026-10-30).
 * Grown to life size; the taxi, cruiser and ambulance already are.
 */
const PACK_SCALE = 1.15;
const CARS = [
  { id: 'sedan', name: 'Sedan', file: PACK, body: 'Sedan Body', engine: 2600, topSpeed: 52 },
  { id: 'compact', name: 'Compact', file: PACK, body: 'Compact Body', engine: 2100, topSpeed: 46 },
  {
    id: 'hatchback',
    name: 'Hatchback',
    file: PACK,
    body: 'Hatchback Body',
    engine: 2300,
    topSpeed: 48,
  },
  { id: 'coupe', name: 'Coupe', file: PACK, body: 'Coupe Body', engine: 3000, topSpeed: 58 },
  { id: 'wagon', name: 'Wagon', file: PACK, body: 'Wagon Body', engine: 2400, topSpeed: 50 },
  { id: 'sport', name: 'Sport', file: PACK, body: 'Sport body', engine: 3800, topSpeed: 66 },
  { id: 'suv', name: 'SUV', file: PACK, body: 'SUV Body', engine: 3200, topSpeed: 50 },
  { id: 'minivan', name: 'Minivan', file: PACK, body: 'minivan body', engine: 2600, topSpeed: 45 },
  { id: 'pickup', name: 'Pickup', file: PACK, body: 'Pickup Body', engine: 3300, topSpeed: 48 },
  {
    id: 'offroad',
    name: 'Off-roader',
    file: PACK,
    body: 'Offroad Body',
    engine: 3400,
    topSpeed: 46,
  },
  {
    id: 'taxi',
    name: 'Taxi',
    file: 'canyon_75_taxi_-_low_poly_model.glb',
    body: 'Canyon75',
    engine: 2700,
    topSpeed: 50,
  },
  {
    id: 'police',
    name: 'Police cruiser',
    file: 'fairheaven_lt_80_cop_cruiser_-_low_poly_model.glb',
    body: 'Fairheaven_LT80',
    engine: 3600,
    topSpeed: 60,
  },
  {
    id: 'ambulance',
    name: 'Ambulance',
    file: 'shvan_92_ambulance_-_low_poly_model.glb',
    body: 'Shvan92',
    engine: 3000,
    topSpeed: 46,
  },
];

const WHEEL = /^Wheel_|Wheel(Stock|Stamp)_/;
const HEAD = /Headlights(?!_Glass)/;
const TAIL = /Brakelights|Reverse/;
/** Hidden from a normal view: simplified harder. */
const HIDDEN = /Bottom|Interior|Suspension|Exhaust|inner/i;

// ---- small column-major 4×4 helpers (glTF matrices) ---------------------------------------
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1)
    for (let r = 0; r < 4; r += 1)
      for (let k = 0; k < 4; k += 1) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
/** World → car: undo the car's place (translation `t`) and heading (yaw about +y). */
function worldToCar(t, yaw) {
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const rot = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  const tr = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t[0], -t[1], -t[2], 1];
  return mul(rot, tr);
}
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scaling = (k) => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
const centre = (b) => b.min.map((v, i) => (v + b.max[i]) / 2);

/** The optics texture's pixels, to tell red tail lenses from white headlamps. */
async function pixels(texture) {
  const { data, info } = await sharp(Buffer.from(texture.getImage()))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (u, v) => {
    const x = Math.min(info.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * info.width)));
    const y = Math.min(info.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * info.height)));
    const i = (y * info.width + x) * info.channels;
    return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
  };
}

/** Where a primitive's red (tail) triangles are, on average, in world space; null if none. */
async function redCentre(node) {
  const world = node.getWorldMatrix();
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const prim of node.getMesh().listPrimitives()) {
    const tex = prim.getMaterial()?.getBaseColorTexture();
    const uv = prim.getAttribute('TEXCOORD_0');
    const pos = prim.getAttribute('POSITION');
    if (!tex || !uv || !pos) continue;
    const at = await pixels(tex);
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    const vi = (k) => (idx ? idx.getScalar(k) : k);
    for (let k = 0; k < count; k += 3) {
      let u = 0;
      let v = 0;
      let x = 0;
      let z = 0;
      for (let j = 0; j < 3; j += 1) {
        const a = uv.getElement(vi(k + j), []);
        const p = pos.getElement(vi(k + j), []);
        u += a[0] / 3;
        v += a[1] / 3;
        // World position of the vertex (x and z only).
        x += (world[0] * p[0] + world[4] * p[1] + world[8] * p[2] + world[12]) / 3;
        z += (world[2] * p[0] + world[6] * p[1] + world[10] * p[2] + world[14]) / 3;
      }
      const [r, g, b] = at(u, v);
      if (r > 0.45 && g < 0.3 && b < 0.3) {
        sx += x;
        sz += z;
        n += 1;
      }
    }
  }
  return n > 0 ? [sx / n, sz / n] : null;
}

/** Splits a lamp primitive's triangles by which end of the car they're at (car space, +z front). */
function splitByEnd(prim, front) {
  const idx = prim.getIndices();
  const pos = prim.getAttribute('POSITION');
  const keep = [];
  for (let k = 0; k < idx.getCount(); k += 3) {
    let z = 0;
    for (let j = 0; j < 3; j += 1) z += pos.getElement(idx.getScalar(k + j), [])[2] / 3;
    if (z > 0 === front) keep.push(idx.getScalar(k), idx.getScalar(k + 1), idx.getScalar(k + 2));
  }
  return keep;
}

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
mkdirSync(out, { recursive: true });

const specs = [];
for (const car of CARS) {
  const doc = await io.read(join(incoming, car.file));
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const nodes = doc
    .getRoot()
    .listNodes()
    .filter((n) => n.getMesh());
  const bodyParts = nodes.filter(
    (n) => n.getName().startsWith(car.body) && !WHEEL.test(n.getName()),
  );
  const bodyBox = getBounds(bodyParts[0]);
  for (const p of bodyParts) {
    const b = getBounds(p);
    for (let i = 0; i < 3; i += 1) {
      bodyBox.min[i] = Math.min(bodyBox.min[i], b.min[i]);
      bodyBox.max[i] = Math.max(bodyBox.max[i], b.max[i]);
    }
  }
  // Wheels (and hub caps) whose centres are under this body.
  const inBody = (n) => {
    const c = centre(getBounds(n));
    return (
      c[0] > bodyBox.min[0] - 0.2 &&
      c[0] < bodyBox.max[0] + 0.2 &&
      c[2] > bodyBox.min[2] - 0.2 &&
      c[2] < bodyBox.max[2] + 0.2
    );
  };
  const wheelish = nodes.filter((n) => WHEEL.test(n.getName()) && inBody(n));
  // The four tyres are the biggest pieces; hub caps belong to the nearest tyre.
  const tyres = [...wheelish]
    .sort((a, b) => {
      const s = (n) => {
        const g = getBounds(n);
        return g.max[1] - g.min[1];
      };
      return s(b) - s(a);
    })
    .slice(0, 4);
  if (tyres.length !== 4) throw new Error(`${car.id}: found ${tyres.length} wheels`);
  const hubs = wheelish.filter((n) => !tyres.includes(n));
  const wc = tyres.map((n) => centre(getBounds(n)));
  const k = car.file === PACK ? PACK_SCALE : 1;
  const wheelR = k * Math.max(...tyres.map((n) => (getBounds(n).max[1] - getBounds(n).min[1]) / 2));
  // Axles: the pairing of the four wheels with the shortest pairs (the track is the short side).
  const pairings = [
    [
      [0, 1],
      [2, 3],
    ],
    [
      [0, 2],
      [1, 3],
    ],
    [
      [0, 3],
      [1, 2],
    ],
  ];
  const d = (a, b) => Math.hypot(wc[a][0] - wc[b][0], wc[a][2] - wc[b][2]);
  const [axleA, axleB] = pairings.sort(
    (p, q) => d(p[0][0], p[0][1]) + d(p[1][0], p[1][1]) - d(q[0][0], q[0][1]) - d(q[1][0], q[1][1]),
  )[0];
  const mid = (pair) => [0, 1, 2].map((i) => (wc[pair[0]][i] + wc[pair[1]][i]) / 2);
  const ca = mid(axleA);
  const cb = mid(axleB);
  let f = [ca[0] - cb[0], ca[2] - cb[2]];
  const flen = Math.hypot(f[0], f[1]);
  f = [f[0] / flen, f[1] / flen];
  const ground = Math.min(...tyres.map((n) => getBounds(n).min[1]));
  const origin = [(ca[0] + cb[0]) / 2, ground, (ca[2] + cb[2]) / 2];
  // Which way is the front: the headlights, or away from the red tail lenses.
  const heads = bodyParts.find((n) => HEAD.test(n.getName()));
  let front;
  if (heads) front = centre(getBounds(heads));
  else {
    const optics = bodyParts.find((n) => /Optics/.test(n.getName()));
    const red = optics ? await redCentre(optics) : null;
    if (!red) throw new Error(`${car.id}: can't tell the front`);
    front = [2 * origin[0] - red[0], 0, 2 * origin[2] - red[1]];
  }
  if ((front[0] - origin[0]) * f[0] + (front[2] - origin[2]) * f[1] < 0) f = [-f[0], -f[1]];
  const yaw = Math.atan2(f[0], f[1]);
  const toCar = mul(scaling(k), worldToCar(origin, yaw));

  // Rebuild the scene as the car's own: body, lamps, one wheel.
  for (const n of scene.listChildren()) scene.removeChild(n);
  const carNode = doc.createNode(car.id);
  scene.addChild(carNode);
  const group = (name) => {
    const g = doc.createNode(name);
    carNode.addChild(g);
    return g;
  };
  const body = group('body');
  const head = group('head');
  const tail = group('tail');
  const wheel = group('wheel');
  const place = (n, parent, extra) => {
    const mesh = n.getMesh().clone();
    transformMesh(
      mesh,
      extra ? mul(extra, mul(toCar, n.getWorldMatrix())) : mul(toCar, n.getWorldMatrix()),
    );
    const node = doc.createNode(n.getName()).setMesh(mesh);
    parent.addChild(node);
    return node;
  };
  for (const n of bodyParts) {
    const name = n.getName();
    if (HEAD.test(name)) place(n, head);
    else if (TAIL.test(name)) place(n, tail);
    else if (/Optics/.test(name)) {
      // One mesh for both ends (the generic pack): split it into head and tail by position.
      const node = place(n, head);
      const tailMesh = doc.createMesh(`${name}_tail`);
      for (const p of node.getMesh().listPrimitives()) {
        // Same vertices, each end its own triangles (and its own primitive).
        const idxType = p.getIndices().getArray().constructor;
        const tp = p.clone();
        tp.setIndices(
          p
            .getIndices()
            .clone()
            .setArray(new idxType(splitByEnd(p, false))),
        );
        p.setIndices(
          p
            .getIndices()
            .clone()
            .setArray(new idxType(splitByEnd(p, true))),
        );
        tailMesh.addPrimitive(tp);
      }
      tail.addChild(doc.createNode(`${name}_tail`).setMesh(tailMesh));
    } else place(n, body);
  }
  // Car-space wheel centres, in the order the game uses: FL (+x, front), FR, RL, RR.
  const carSpace = (c) => {
    const x = c[0] - origin[0];
    const z = c[2] - origin[2];
    return [
      k * (x * Math.cos(-yaw) + z * Math.sin(-yaw)),
      k * (c[1] - origin[1]),
      k * (-x * Math.sin(-yaw) + z * Math.cos(-yaw)),
    ];
  };
  const placed = tyres.map((n, i) => ({ n, c: carSpace(wc[i]) }));
  const fl = placed.find((p) => p.c[0] > 0 && p.c[2] > 0);
  const fr = placed.find((p) => p.c[0] < 0 && p.c[2] > 0);
  const rl = placed.find((p) => p.c[0] > 0 && p.c[2] < 0);
  const rr = placed.find((p) => p.c[0] < 0 && p.c[2] < 0);
  if (!fl || !fr || !rl || !rr) throw new Error(`${car.id}: wheels not one at each corner`);
  // The front-left wheel and its hub cap, centred on the hub.
  const toHub = translate(-fl.c[0], -fl.c[1], -fl.c[2]);
  place(fl.n, wheel, toHub);
  for (const h of hubs) {
    const hc = carSpace(centre(getBounds(h)));
    if (Math.hypot(hc[0] - fl.c[0], hc[2] - fl.c[2]) < 0.4) place(h, wheel, toHub);
  }

  // Lighter: drop what's now unused, join parts by material, simplify the hidden detail.
  const translucent = /Glass|Transperent|Transparent/;
  for (const m of doc.getRoot().listMaterials()) {
    // Badges and number plates: cut-out instead of blended (no sorting, cheaper).
    if (m.getAlphaMode() === 'BLEND' && !translucent.test(m.getName()))
      m.setAlphaMode('MASK').setAlphaCutoff(0.5);
  }
  await doc.transform(prune(), dedup(), weld());
  for (const n of body.listChildren()) {
    if (!HIDDEN.test(n.getName())) continue;
    for (const p of n.getMesh().listPrimitives())
      if ((p.getIndices()?.getCount() ?? 0) > 600)
        simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0.4, error: 0.004 });
  }
  // Lamp lenses are a few pixels on screen: their textures go small.
  for (const m of doc.getRoot().listMaterials())
    if (/Optics|Lights/.test(m.getName())) m.getBaseColorTexture()?.setName('lamp');
  await doc.transform(
    joinMeshes({ keepNamed: false }),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'png', pattern: /^lamp$/, resize: [256, 256] }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'png',
      slots: /^baseColor/,
      resize: [1024, 1024],
    }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'png',
      slots: /^(?!baseColor)/,
      resize: [512, 512],
    }),
    toktx({ mode: Mode.ETC1S, quality: 192 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const file = join(out, `${car.id}.glb`);
  await io.write(file, doc);

  // Measurements for driving and collisions.
  const bb = getBounds(body);
  const tris = doc
    .getRoot()
    .listMeshes()
    .reduce(
      (s, m) =>
        s + m.listPrimitives().reduce((t, p) => t + (p.getIndices()?.getCount() ?? 0) / 3, 0),
      0,
    );
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const spec = {
    id: car.id,
    name: car.name,
    length: r3(bb.max[2] - bb.min[2]),
    width: r3(bb.max[0] - bb.min[0]),
    height: r3(bb.max[1] - bb.min[1]),
    wheelRadius: r3(wheelR),
    wheels: [fl, fr, rl, rr].map((p) => p.c.map(r3)),
    half: [
      r3((bb.max[0] - bb.min[0]) / 2),
      r3((bb.max[1] - Math.max(bb.min[1], 0.15)) / 2),
      r3((bb.max[2] - bb.min[2]) / 2),
    ],
    centreY: r3((bb.max[1] + Math.max(bb.min[1], 0.15)) / 2),
    engine: car.engine,
    topSpeed: car.topSpeed,
  };
  specs.push(spec);
  console.log(
    `${car.id.padEnd(10)} ${(statSync(file).size / 1024).toFixed(0).padStart(5)} KB  ${String(Math.round(tris)).padStart(6)} tris  ` +
      `${spec.length}×${spec.width}×${spec.height} m  wheels r ${spec.wheelRadius}`,
  );
}

writeFileSync(
  join(root, 'packages/shared/src/car-models.ts'),
  `/**
 * The cars' measurements, generated by scripts/assets/cars.mjs from their models
 * (apps/client/public/assets/cars/<id>.glb). Car space: +z forward, +x left, y up, the origin
 * on the ground between the axles. Don't edit by hand: run the script.
 */

export interface CarModelSpec {
  id: string;
  name: string;
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
  /** Wheel hubs: front left, front right, rear left, rear right. */
  wheels: [number, number, number][];
  /** Collision box half-extents, and its centre's height. */
  half: [number, number, number];
  centreY: number;
  /** Engine force per driven wheel (N) and top speed (m/s). */
  engine: number;
  topSpeed: number;
}

export const CAR_MODELS: CarModelSpec[] = ${JSON.stringify(specs, null, 2)};

/** The everyday cars parked around the city (the taxi, police and ambulance come with jobs). */
export const CIVILIAN_CARS = ${CARS.filter((c) => c.file === PACK).length};
`,
);
console.log('wrote packages/shared/src/car-models.ts');
