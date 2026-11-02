/**
 * Accessories (the shared Gear): hats, eyewear, chains, watches and bags, modelled here in
 * code (no downloads; original shapes) and fixed to the skeleton's bones, so they move with
 * the head, neck, chest and wrist. Hats and eyewear are fitted to each face: its head is
 * measured in the Head bone's frame (crown, width, forehead, back, eyes) and the item built to
 * those sizes, so a cap sits over the face's own hair.
 *
 * Every item is built in a "model" frame (x the character's left, y up, z forward; metres)
 * and turned onto its bone's frame (the Rocketbox bones run along +x, with +y forward and +z
 * to the left).
 */
import {
  BAGS,
  CLOTHES_COLOURS,
  EYEWEAR,
  type Gear,
  HEADWEAR,
  NECKWEAR,
  WRISTWEAR,
} from '@fr33world/shared';
import * as THREE from 'three';

/** Model frame (x left, y up, z forward) → a Rocketbox bone's frame (x up, y forward, z left). */
const TO_BONE = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
);

/** A face's head in the Head bone's frame (model axes: x left, y up, z forward; metres). */
export interface HeadFit {
  /** Top of the head (hair included) above the Head bone. */
  top: number;
  /** Half the width at the temples. */
  half: number;
  /** Forehead and back of the head at brow height (z). */
  front: number;
  back: number;
  /** The eyes: height, how far forward, and half their spacing. */
  eyeY: number;
  eyeZ: number;
  eyeX: number;
  /** The eyebrows' height. */
  brow: number;
}

/** Measures a face (a loaded face part, before it's bound to an outfit). */
export function measureHead(face: THREE.Object3D): HeadFit | null {
  face.updateMatrixWorld(true);
  let head: THREE.Object3D | undefined;
  let eye: THREE.Object3D | undefined;
  let brow: THREE.Object3D | undefined;
  face.traverse((o) => {
    if (!head && /Head$/.test(o.name) && (o as THREE.Bone).isBone) head = o;
    if (!eye && /LEye$/.test(o.name)) eye = o;
    if (!brow && /MMiddleEyebrow$/.test(o.name)) brow = o;
  });
  if (!head || !eye || !brow) return null;
  const inv = head.matrixWorld.clone().invert();
  // Bone frame (x up, y forward, z left) → model (x left, y up, z forward).
  const toModel = (v: THREE.Vector3) => v.set(v.z, v.x, v.y);
  const e = toModel(eye.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
  const b = toModel(brow.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
  const fit: HeadFit = {
    top: b.y + 0.06,
    half: 0.07,
    front: b.z,
    back: b.z - 0.18,
    eyeY: e.y,
    eyeZ: e.z,
    eyeX: Math.abs(e.x),
    brow: b.y,
  };
  const v = new THREE.Vector3();
  let back = 0;
  face.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const p = m.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i += 1) {
      toModel(v.fromBufferAttribute(p, i).applyMatrix4(m.bindMatrix).applyMatrix4(inv));
      // The crown: near the middle, from above.
      if (Math.abs(v.x) < 0.04 && Math.abs(v.z - b.z + 0.09) < 0.06)
        fit.top = Math.max(fit.top, v.y);
      // Temples and back, around the hat band's height (long hair hanging lower is left out).
      if (v.y > b.y - 0.02 && v.y < b.y + 0.05) {
        fit.half = Math.max(fit.half, Math.abs(v.x));
        back = Math.min(back, v.z);
      }
    }
  });
  // Clamped: a big bun or loose hair shouldn't make a sombrero.
  fit.half = Math.min(fit.half, 0.105);
  fit.back = Math.max(back, fit.front - 0.25);
  fit.top = Math.min(fit.top, b.y + 0.15);
  return fit;
}

// ---- materials ----------------------------------------------------------------------------

/** Cotton twill: a fine diagonal weave, as a bump in the colour (one texture for all). */
let twill: THREE.CanvasTexture | null = null;
function twillTexture(): THREE.CanvasTexture {
  if (twill) return twill;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1.2;
  for (let k = -64; k < 128; k += 4) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 64, 64);
    g.stroke();
  }
  twill = new THREE.CanvasTexture(c);
  twill.wrapS = twill.wrapT = THREE.RepeatWrapping;
  twill.repeat.set(10, 10);
  twill.colorSpace = THREE.SRGBColorSpace;
  return twill;
}

const fabric = (hex: string) =>
  new THREE.MeshStandardMaterial({ color: hex, map: twillTexture(), roughness: 0.9 });
const METALS = {
  gold: () => new THREE.MeshStandardMaterial({ color: 0xd9a93a, metalness: 1, roughness: 0.28 }),
  silver: () => new THREE.MeshStandardMaterial({ color: 0xd2d6da, metalness: 1, roughness: 0.22 }),
  black: () => new THREE.MeshStandardMaterial({ color: 0x18191b, metalness: 0.4, roughness: 0.35 }),
};

// ---- hats ---------------------------------------------------------------------------------

/**
 * A crown over the head: an ellipsoid shell from a band (`front` high at the forehead, `back`
 * lower behind) up to the top, `pad` clear of the head.
 */
function crown(
  fit: HeadFit,
  frontBand: number,
  backBand: number,
  pad: number,
  lift = 0,
  /** Stop this far above the band (a cuff), instead of closing over the top. */
  upTo = Infinity,
  /** Flatten the top: no higher than this share of the height (a bucket hat's crown). */
  flat = 1,
) {
  const cz = (fit.front + fit.back) / 2;
  const cy = fit.brow + 0.01;
  const rx = fit.half + pad;
  const rz = (fit.front - fit.back) / 2 + pad;
  const ry = fit.top - cy + pad + lift;
  const seg = 48;
  const rings = 16;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    // Forward is a = 0: the band from the forehead round to the back.
    const front = (1 + Math.cos(a)) / 2;
    const band = backBand + (frontBand - backBand) * front;
    const e0 = Math.asin(THREE.MathUtils.clamp((band - cy) / ry, -0.95, 0.95));
    const e1 =
      upTo === Infinity
        ? Math.PI / 2
        : Math.asin(THREE.MathUtils.clamp((band + upTo - cy) / ry, -0.95, 0.99));
    for (let j = 0; j <= rings; j += 1) {
      const e = e0 + (e1 - e0) * (j / rings);
      pos.push(
        Math.sin(a) * Math.cos(e) * rx,
        cy + Math.min(Math.sin(e), flat) * ry,
        cz + Math.cos(a) * Math.cos(e) * rz,
      );
      uv.push(i / seg, j / rings);
    }
  }
  for (let i = 0; i < seg; i += 1) {
    for (let j = 0; j < rings; j += 1) {
      const k = i * (rings + 1) + j;
      idx.push(k, k + rings + 1, k + 1, k + 1, k + rings + 1, k + rings + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, cz, cy, rx, ry, rz };
}

/** The ring where a crown meets its band, at `a` round from the front (model coords). */
function rim(c: ReturnType<typeof crown>, band: number, a: number): THREE.Vector3 {
  const e = Math.asin(THREE.MathUtils.clamp((band - c.cy) / c.ry, -0.95, 0.95));
  return new THREE.Vector3(
    Math.sin(a) * Math.cos(e) * c.rx,
    band,
    c.cz + Math.cos(a) * Math.cos(e) * c.rz,
  );
}

/** A baseball cap: six-panel crown, a curved peak, a button on top. */
function cap(fit: HeadFit, colour: string, backwards = false): THREE.Group {
  const g = new THREE.Group();
  const m = fabric(colour);
  const frontBand = fit.brow + 0.03;
  const backBand = fit.brow - 0.03;
  const c = crown(fit, frontBand, backBand, 0.01, -0.012);
  g.add(new THREE.Mesh(c.geometry, [m][0]));
  // The peak: from the crown's front edge out 7 cm, curved across and tipped down a little.
  const pos: number[] = [];
  const idx: number[] = [];
  const steps = 24;
  const spread = 0.95;
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps - 0.5;
    // Worn backwards, the peak comes off the back of the band instead.
    const a = u * 2 * spread + (backwards ? Math.PI : 0);
    const inner = rim(c, backwards ? backBand : frontBand, a);
    // A rounded D: 7 cm out at the middle, closing in at the sides; bent down at the sides.
    const len = 0.072 * Math.sqrt(Math.max(0, 1 - (2 * u) ** 2)) + 0.004;
    const out = new THREE.Vector3(Math.sin(a) * 0.55, 0, Math.cos(a))
      .normalize()
      .multiplyScalar(len);
    const outer = inner.clone().add(out);
    outer.y -= 0.006 + 0.022 * (2 * u) ** 2;
    for (const [p, dy] of [
      [inner, 0],
      [outer, 0],
      [inner, -0.005],
      [outer, -0.005],
    ] as const)
      pos.push(p.x, p.y + dy, p.z);
  }
  for (let i = 0; i < steps; i += 1) {
    const k = i * 4;
    const n = k + 4;
    idx.push(k, n, k + 1, k + 1, n, n + 1); // top
    idx.push(k + 2, k + 3, n + 2, k + 3, n + 3, n + 2); // underside
    idx.push(k + 1, n + 1, k + 3, k + 3, n + 1, n + 3); // edge
  }
  const peak = new THREE.BufferGeometry();
  peak.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  peak.setIndex(idx);
  peak.computeVertexNormals();
  g.add(new THREE.Mesh(peak, m));
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), m);
  button.position.set(0, c.cy + c.ry, c.cz);
  g.add(button);
  return g;
}

/** A knitted beanie: a taller crown, ribbed, with a turned-up cuff. */
function beanie(fit: HeadFit, colour: string): THREE.Group {
  const g = new THREE.Group();
  const knit = new THREE.MeshStandardMaterial({ color: colour, map: ribTexture(), roughness: 1 });
  const band = fit.brow + 0.01;
  const backBand = fit.brow - 0.045;
  // A soft crown with a little slouch, and a deep turned-up cuff a few millimetres proud of it.
  const c = crown(fit, band, backBand, 0.013, 0.022);
  g.add(new THREE.Mesh(c.geometry, knit));
  const cuff = crown(fit, band - 0.002, backBand - 0.002, 0.02, 0.022, 0.048);
  g.add(new THREE.Mesh(cuff.geometry, knit));
  return g;
}

/** Knitted rib: vertical ridges (round a crown, its u runs round the head). */
let rib: THREE.CanvasTexture | null = null;
function ribTexture(): THREE.CanvasTexture {
  if (rib) return rib;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 32, 0);
  grad.addColorStop(0, '#9a9a9a');
  grad.addColorStop(0.5, '#ffffff');
  grad.addColorStop(1, '#9a9a9a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  rib = new THREE.CanvasTexture(c);
  rib.wrapS = rib.wrapT = THREE.RepeatWrapping;
  rib.repeat.set(60, 1);
  rib.colorSpace = THREE.SRGBColorSpace;
  return rib;
}

/** A bucket hat: a soft crown and a brim sloping down all round. */
function bucket(fit: HeadFit, colour: string): THREE.Group {
  const g = new THREE.Group();
  const m = fabric(colour);
  m.side = THREE.DoubleSide;
  const band = fit.brow + 0.02;
  const c = crown(fit, band, fit.brow - 0.01, 0.016, 0.01, Infinity, 0.86);
  g.add(new THREE.Mesh(c.geometry, m));
  const pos: number[] = [];
  const idx: number[] = [];
  const seg = 48;
  for (let i = 0; i <= seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    const front = (1 + Math.cos(a)) / 2;
    const inner = rim(c, fit.brow - 0.01 + (band - fit.brow + 0.01) * front, a);
    const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.042);
    const outer = inner.clone().add(out);
    outer.y -= 0.03;
    pos.push(inner.x, inner.y, inner.z, outer.x, outer.y, outer.z);
  }
  for (let i = 0; i < seg; i += 1) {
    const k = i * 2;
    idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const brim = new THREE.BufferGeometry();
  brim.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  brim.setIndex(idx);
  brim.computeVertexNormals();
  g.add(new THREE.Mesh(brim, m));
  return g;
}

// ---- eyewear ------------------------------------------------------------------------------

/** A lens outline (half-width, half-height), as a closed curve. */
function lensShape(kind: 'shades' | 'glasses' | 'aviators', w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  if (kind === 'aviators') {
    // A teardrop: wide at the top, dropping to a rounded point towards the nose.
    s.moveTo(-w, h * 0.7);
    s.bezierCurveTo(-w * 0.2, h * 1.05, w * 0.6, h * 1.05, w, h * 0.65);
    s.bezierCurveTo(w * 1.08, -h * 0.3, w * 0.4, -h * 1.25, -w * 0.25, -h);
    s.bezierCurveTo(-w * 0.9, -h * 0.85, -w * 1.05, 0, -w, h * 0.7);
    return s;
  }
  const r = kind === 'glasses' ? h * 0.55 : h * 0.4;
  s.moveTo(-w + r, h);
  s.lineTo(w - r, h);
  s.quadraticCurveTo(w, h, w, h - r);
  s.lineTo(w, -h + r);
  s.quadraticCurveTo(w, -h, w - r, -h);
  s.lineTo(-w + r, -h);
  s.quadraticCurveTo(-w, -h, -w, -h + r);
  s.lineTo(-w, h - r);
  s.quadraticCurveTo(-w, h, -w + r, h);
  return s;
}

function eyewear(fit: HeadFit, kind: 'shades' | 'glasses' | 'aviators'): THREE.Group {
  const g = new THREE.Group();
  const s = fit.eyeX / 0.032;
  const w = (kind === 'glasses' ? 0.024 : 0.027) * s;
  const h = (kind === 'glasses' ? 0.016 : kind === 'shades' ? 0.019 : 0.022) * s;
  const z = fit.eyeZ + 0.033;
  const y = fit.eyeY - (kind === 'aviators' ? 0.003 : 0.001);
  const frameMat =
    kind === 'aviators'
      ? METALS.gold()
      : new THREE.MeshStandardMaterial({
          color: kind === 'shades' ? 0x101012 : 0x2a1d16,
          roughness: 0.35,
        });
  const lensMat = new THREE.MeshStandardMaterial({
    color: kind === 'glasses' ? 0xdfe8ee : kind === 'aviators' ? 0x3d4a2e : 0x0b0d10,
    roughness: 0.04,
    metalness: kind === 'glasses' ? 0 : 0.5,
    transparent: true,
    opacity: kind === 'glasses' ? 0.14 : 0.88,
    envMapIntensity: 1.6,
  });
  const rimWidth = kind === 'aviators' ? 0.0018 : kind === 'glasses' ? 0.0024 : 0.0045;
  for (const side of [-1, 1]) {
    const cx = side * (fit.eyeX + 0.002);
    const outline = lensShape(kind, w, h);
    // The frame: the outline, a rim's width out, with the lens's shape as its hole.
    const frameShape = lensShape(kind, w + rimWidth, h + rimWidth);
    frameShape.holes.push(new THREE.Path(outline.getPoints(32)));
    const frame = new THREE.ExtrudeGeometry(frameShape, {
      depth: kind === 'aviators' ? 0.002 : 0.004,
      bevelEnabled: false,
      curveSegments: 16,
    });
    const lens = new THREE.ShapeGeometry(outline, 16);
    for (const [geo, mat] of [
      [frame, frameMat],
      [lens, lensMat],
    ] as const) {
      const mesh = new THREE.Mesh(geo, mat);
      // Mirrored for the other eye (aviators point their drop towards the nose), and turned
      // out a little to follow the face.
      mesh.scale.x = side;
      mesh.rotation.y = side * 0.12;
      mesh.position.set(cx, y, z);
      g.add(mesh);
    }
  }
  // The bridge over the nose, and the arms back over the ears.
  const bridge = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-fit.eyeX + w * 0.95, y + h * 0.35, z + 0.002),
        new THREE.Vector3(0, y + h * 0.75, z + 0.004),
        new THREE.Vector3(fit.eyeX - w * 0.95, y + h * 0.35, z + 0.002),
      ),
      12,
      0.0016,
      6,
    ),
    frameMat,
  );
  g.add(bridge);
  for (const side of [-1, 1]) {
    const x0 = side * (fit.eyeX + w + 0.002);
    const armX = side * (fit.half - 0.004);
    const arm = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(x0, y + h * 0.5, z - 0.002),
        new THREE.Vector3(armX, y + h * 0.45, z - 0.03),
        new THREE.Vector3(armX, y + h * 0.2, fit.eyeZ - 0.09),
        new THREE.Vector3(armX * 0.96, y - 0.012, fit.eyeZ - 0.108),
      ]),
      16,
      kind === 'shades' ? 0.0022 : 0.0014,
      6,
    );
    g.add(new THREE.Mesh(arm, frameMat));
  }
  return g;
}

// ---- chains -------------------------------------------------------------------------------

/**
 * A chain round the neck (Neck bone frame, model axes): links along a loop that lies on the
 * collar at the back and sides and drops onto the chest in front.
 */
function chain(kind: 'gold_chain' | 'silver_chain' | 'cuban', female: boolean): THREE.Group {
  const k = female ? 0.9 : 1;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 40; i += 1) {
    const a = (i / 40) * Math.PI * 2;
    const front = Math.max(0, Math.cos(a));
    pts.push(
      new THREE.Vector3(
        Math.sin(a) * 0.072 * k * (1 + 0.25 * front),
        0.012 - 0.11 * k * front ** 2.2,
        (Math.cos(a) * (Math.cos(a) > 0 ? 0.085 : 0.07) + 0.015) * k + 0.03 * front ** 2,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  const cuban = kind === 'cuban';
  const linkLen = cuban ? 0.011 : 0.0075;
  const count = Math.round(curve.getLength() / linkLen);
  const link = new THREE.TorusGeometry(cuban ? 0.0055 : 0.0034, cuban ? 0.0019 : 0.00095, 6, 10);
  link.scale(1.35, 1, cuban ? 0.55 : 1);
  const mesh = new THREE.InstancedMesh(
    link,
    kind === 'silver_chain' ? METALS.silver() : METALS.gold(),
    count,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const twist = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const x = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    const p = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    // Each link along the chain, every other one turned a quarter about it (cuban links lie
    // flat on the chest instead).
    q.setFromUnitVectors(x.set(1, 0, 0), tangent);
    if (!cuban && i % 2) q.multiply(twist.setFromAxisAngle(x.set(1, 0, 0), Math.PI / 2));
    if (cuban) q.multiply(twist.setFromAxisAngle(x.set(1, 0, 0), Math.PI / 2));
    m.compose(p, q, one);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

// ---- watches ------------------------------------------------------------------------------

/**
 * A watch for the left wrist, built along y (the forearm bone's axis in the model frame),
 * its face looking out along z.
 */
function watch(kind: 'gold_watch' | 'silver_watch' | 'black_watch'): THREE.Group {
  const g = new THREE.Group();
  const metal =
    kind === 'gold_watch'
      ? METALS.gold()
      : kind === 'silver_watch'
        ? METALS.silver()
        : METALS.black();
  // The band: an open sleeve round the wrist (oval, as a wrist is).
  const band = new THREE.CylinderGeometry(0.031, 0.031, 0.02, 32, 1, true);
  band.scale(0.85, 1, 1.12);
  const bandMat = (kind === 'black_watch' ? METALS.black() : metal).clone();
  bandMat.side = THREE.DoubleSide;
  g.add(new THREE.Mesh(band, bandMat));
  // The face: hour marks and two hands, painted.
  const face = document.createElement('canvas');
  face.width = face.height = 64;
  const c = face.getContext('2d') as CanvasRenderingContext2D;
  c.fillStyle = kind === 'black_watch' ? '#0d0f12' : '#f2efe6';
  c.beginPath();
  c.arc(32, 32, 31, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = kind === 'black_watch' ? '#7def06' : '#202226';
  c.lineWidth = 3;
  for (let h = 0; h < 12; h += 1) {
    const a = (h / 12) * Math.PI * 2;
    c.beginPath();
    c.moveTo(32 + Math.sin(a) * 24, 32 - Math.cos(a) * 24);
    c.lineTo(32 + Math.sin(a) * 28, 32 - Math.cos(a) * 28);
    c.stroke();
  }
  c.beginPath();
  c.moveTo(32, 32);
  c.lineTo(32, 14);
  c.moveTo(32, 32);
  c.lineTo(46, 36);
  c.stroke();
  const tex = new THREE.CanvasTexture(face);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The case: a short cylinder whose top (its face) turns to look along z.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.019, 0.009, 28), [
    metal,
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.2 }),
    metal,
  ]);
  body.rotation.x = Math.PI / 2;
  body.position.z = 0.036;
  g.add(body);
  return g;
}

// ---- bags ---------------------------------------------------------------------------------

/** A rounded box (front panel, depth, and corner radius). */
function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: d - 2 * Math.min(r, d / 3),
    bevelEnabled: true,
    bevelThickness: Math.min(r, d / 3),
    bevelSize: Math.min(r, d / 3) * 0.8,
    bevelSegments: 4,
    curveSegments: 6,
  });
  g.translate(0, 0, -(d - 2 * Math.min(r, d / 3)) / 2);
  return g;
}

/** A strap: a flat band along points (model coords). */
function strap(points: THREE.Vector3[], width: number, m: THREE.Material): THREE.Mesh {
  const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 32, width / 2, 4, false);
  g.scale(1, 1, 1);
  return new THREE.Mesh(g, m);
}

/** A backpack on the back (Spine2 frame, model axes: y up the spine, z forward). */
function backpack(colour: string, female: boolean): THREE.Group {
  const g = new THREE.Group();
  const m = fabric(colour);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 });
  const k = female ? 0.92 : 1;
  const back = -0.125 * k;
  const pack = new THREE.Mesh(roundedBox(0.3 * k, 0.4 * k, 0.13, 0.05), m);
  pack.position.set(0, -0.06, back - 0.075);
  g.add(pack);
  const pocket = new THREE.Mesh(roundedBox(0.22 * k, 0.15 * k, 0.05, 0.025), m);
  pocket.position.set(0, -0.17, back - 0.155);
  g.add(pocket);
  const zip = new THREE.Mesh(new THREE.BoxGeometry(0.2 * k, 0.004, 0.004), dark);
  zip.position.set(0, -0.095, back - 0.18);
  g.add(zip);
  for (const side of [-1, 1]) {
    const x = side * 0.085 * k;
    g.add(
      strap(
        [
          new THREE.Vector3(x, 0.12, back - 0.03),
          new THREE.Vector3(x * 1.1, 0.19, -0.02),
          new THREE.Vector3(x * 1.25, 0.15, 0.1 * k),
          new THREE.Vector3(x * 1.35, 0.0, 0.135 * k),
          new THREE.Vector3(x * 1.45, -0.14, 0.11 * k),
          new THREE.Vector3(x * 1.5, -0.24, back - 0.02),
        ],
        0.045,
        dark,
      ),
    );
  }
  return g;
}

/** A sling bag worn across the chest: a pouch on the chest, its strap over the right shoulder. */
function sling(colour: string, female: boolean): THREE.Group {
  const g = new THREE.Group();
  const m = fabric(colour);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 });
  const k = female ? 0.92 : 1;
  const front = 0.17 * k;
  const pouch = new THREE.Mesh(roundedBox(0.24, 0.12, 0.07, 0.035), m);
  pouch.position.set(0.04, -0.08, front + 0.03);
  pouch.rotation.z = -0.45;
  g.add(pouch);
  g.add(
    strap(
      [
        new THREE.Vector3(0.14, -0.02, front),
        new THREE.Vector3(-0.02, 0.1, front - 0.01),
        new THREE.Vector3(-0.12 * k, 0.2, 0.03),
        new THREE.Vector3(-0.1 * k, 0.12, -0.13 * k),
        new THREE.Vector3(0.04, -0.06, -0.14 * k),
        new THREE.Vector3(0.16 * k, -0.17, -0.06),
        new THREE.Vector3(0.18 * k, -0.18, 0.08),
        new THREE.Vector3(0.14, -0.13, front - 0.01),
      ],
      0.035,
      dark,
    ),
  );
  return g;
}

// ---- wearing ------------------------------------------------------------------------------

function bone(root: THREE.Object3D, re: RegExp): THREE.Object3D | undefined {
  let b: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!b && re.test(o.name) && (o as THREE.Bone).isBone) b = o;
  });
  return b;
}

/** Fixes `item` (model frame) to `onto` (a bone), at real size whatever the rig's scale. */
function fix(onto: THREE.Object3D, item: THREE.Object3D) {
  const holder = new THREE.Group();
  holder.name = 'gear';
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(TO_BONE);
  holder.add(item);
  item.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    // Small and moving with the body: never cull by stale bounds.
    mesh.frustumCulled = false;
  });
  onto.add(holder);
}

const colourOf = (i: number) => CLOTHES_COLOURS[i] ?? '#1d1d1f';

/** Puts `gear` on a character (outfit skeleton `root`; `fit` from its face). */
export function wear(root: THREE.Object3D, gear: Gear, fit: HeadFit | null, female: boolean): void {
  const head = bone(root, /Head$/);
  const hat = HEADWEAR[gear.head];
  if (head && fit && hat && hat !== 'none') {
    const colour = colourOf(gear.headColour);
    const item =
      hat === 'beanie'
        ? beanie(fit, colour)
        : hat === 'bucket'
          ? bucket(fit, colour)
          : cap(fit, colour, hat === 'cap_back');
    fix(head, item);
  }
  const glasses = EYEWEAR[gear.eyes];
  if (head && fit && glasses && glasses !== 'none') fix(head, eyewear(fit, glasses));
  const neck = NECKWEAR[gear.neck];
  const neckBone = bone(root, /Neck$/);
  if (neckBone && neck && neck !== 'none') fix(neckBone, chain(neck, female));
  const wrist = WRISTWEAR[gear.wrist];
  const forearm = bone(root, /LeftForeArm$/);
  const hand = bone(root, /LeftHand$/);
  if (forearm && hand && wrist && wrist !== 'none') {
    // 3.5 cm up the arm from the wrist joint (the hand bone's offset along the forearm).
    const w = watch(wrist);
    w.position.y = hand.position.x - 0.035;
    fix(forearm, w);
  }
  const bag = BAGS[gear.bag];
  const spine = bone(root, /Spine2$/);
  if (spine && bag && bag !== 'none') {
    const colour = colourOf(gear.bagColour);
    fix(spine, bag === 'backpack' ? backpack(colour, female) : sling(colour, female));
  }
}
