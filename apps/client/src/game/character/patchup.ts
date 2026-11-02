/**
 * Patching yourself up (owner, 2026-10-31): the arms wrap a bandage round the forearm, or throw a
 * pill in the mouth. No clip does either, so each is solved here for the character's own skeleton
 * (two-bone IK towards hand paths set out in body space) and baked once into an upper-body clip,
 * which plays like any other overlay: the legs stay free. With it comes what's in the hands, a
 * gauze roll and the band it leaves on the arm, or the bottle and the pill (CareProps).
 */
import * as THREE from 'three';

export type CareGesture = 'bandaging' | 'medicine';
export const CARE_SECONDS: Record<CareGesture, number> = { bandaging: 3.2, medicine: 2.1 };

const FPS = 30;
const LEFT_BONES = ['LeftArm', 'LeftForeArm', 'LeftHand'] as const;
const RIGHT_BONES = ['RightArm', 'RightForeArm', 'RightHand'] as const;

const bone = (root: THREE.Object3D, name: string) =>
  root.getObjectByName(`mixamorig${name}`) ?? root.getObjectByName(name);

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
/** Up from 0 between a and b, back down between c and d. */
const hump = (t: number, a: number, b: number, c: number, d: number) =>
  smooth((t - a) / (b - a)) * (1 - smooth((t - c) / (d - c)));

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const D = new THREE.Vector3();
const Q = new THREE.Quaternion();
const P = new THREE.Quaternion();

/** Turns `b` so the point `from` (world) on it swings to `to`, about its own joint. */
function aim(b: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  b.getWorldPosition(A);
  const was = B.copy(from).sub(A).normalize();
  const want = C.copy(to).sub(A).normalize();
  Q.setFromUnitVectors(was, want);
  (b.parent as THREE.Object3D).getWorldQuaternion(P);
  // The world turn, seen from the parent: q' = P⁻¹ · turn · P · q.
  b.quaternion.premultiply(P.clone().invert().multiply(Q).multiply(P)).normalize();
  b.updateWorldMatrix(false, true);
}

/**
 * Two-bone IK: turns `upper` and `lower` so `hand` reaches `target`, the elbow bending towards
 * `pole` (all world). A target out of reach is reached for.
 */
export function solveArm(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  hand: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
): void {
  const s = upper.getWorldPosition(new THREE.Vector3());
  const e = lower.getWorldPosition(new THREE.Vector3());
  const h = hand.getWorldPosition(new THREE.Vector3());
  const a = e.distanceTo(s);
  const b = h.distanceTo(e);
  const to = target.clone().sub(s);
  const d = THREE.MathUtils.clamp(to.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  to.normalize();
  const cos = (a * a + d * d - b * b) / (2 * a * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const bend = pole.clone().sub(s);
  bend.addScaledVector(to, -bend.dot(to)).normalize();
  const elbow = s
    .clone()
    .addScaledVector(to, a * cos)
    .addScaledVector(bend, a * sin);
  aim(upper, e, elbow);
  lower.getWorldPosition(e);
  hand.getWorldPosition(h);
  aim(lower, h, s.clone().addScaledVector(to, d));
}

/** Where each hand goes at time `t`, how far (0–1) from the idle, and the head's tilt. */
interface Path {
  seconds: number;
  /** Body space: +x its left, +y up, +z forward, from between the feet; unit: an arm's length. */
  left(t: number, out: THREE.Vector3): number;
  right(t: number, out: THREE.Vector3): number;
  /** Radians, forward positive. */
  head(t: number): number;
  leftPole: THREE.Vector3;
  rightPole: THREE.Vector3;
}

interface Frame {
  /** Shoulder height, and the length an arm reaches. */
  chest: number;
  reach: number;
}

function bandagingPath({ chest, reach }: Frame): Path {
  const seconds = CARE_SECONDS.bandaging;
  // The left hand held out across the body, palm down; the right goes round its forearm.
  const wrist = new THREE.Vector3(0.02 * reach, chest - 0.3 * reach, 0.6 * reach);
  const along = new THREE.Vector3(0.9, 0.12, -0.42).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  up.addScaledVector(along, -up.dot(along)).normalize();
  const side = new THREE.Vector3().crossVectors(along, up);
  const raised = (t: number) => hump(t, 0, 0.55, seconds - 0.55, seconds);
  return {
    seconds,
    left(t, out) {
      out.copy(wrist);
      return raised(t);
    },
    right(t, out) {
      const turns = 3 * Math.max(0, Math.min(1, (t - 0.45) / (seconds - 1)));
      const angle = turns * Math.PI * 2 + 1.2;
      const drift = 0.12 + 0.24 * (turns / 3);
      const r = 0.11 * reach;
      out
        .copy(wrist)
        .addScaledVector(along, drift * reach)
        .addScaledVector(up, Math.cos(angle) * r)
        .addScaledVector(side, Math.sin(angle) * r);
      return raised(t);
    },
    head: (t) => 0.42 * raised(t),
    leftPole: new THREE.Vector3(1.4, -1, -0.9),
    rightPole: new THREE.Vector3(-1.4, -1.1, -0.6),
  };
}

function medicinePath({ chest, reach }: Frame): Path {
  const seconds = CARE_SECONDS.medicine;
  const mouth = new THREE.Vector3(0, chest + 0.2 * reach, 0.2 * reach);
  const bottle = new THREE.Vector3(0.26 * reach, chest - 0.5 * reach, 0.42 * reach);
  return {
    seconds,
    left(t, out) {
      out.copy(bottle);
      return hump(t, 0, 0.35, seconds - 0.45, seconds);
    },
    right(t, out) {
      // Up to the mouth, a toss, then away while the head stays back.
      const toss = hump(t, 0.55, 0.68, 0.7, 0.95);
      out.copy(mouth);
      out.y += toss * 0.06 * reach;
      out.z += (1 - toss) * 0.03 * reach;
      return hump(t, 0, 0.5, 0.95, 1.5);
    },
    // Down at the pill, back to swallow.
    head: (t) => 0.2 * hump(t, 0, 0.3, 0.45, 0.6) - 0.55 * hump(t, 0.5, 0.75, 1.35, 1.8),
    leftPole: new THREE.Vector3(1.4, -1, -0.7),
    rightPole: new THREE.Vector3(-1.2, -1.2, -0.4),
  };
}

/**
 * Bakes a gesture for this skeleton. `idle` is the pose it starts from and returns to; the bones
 * it doesn't move hold that pose, so nothing sags while the clip plays over the running upper
 * body. Leaves the skeleton as it found it.
 */
export function bakeGesture(
  root: THREE.Object3D,
  idle: THREE.AnimationClip,
  kind: CareGesture,
): THREE.AnimationClip | null {
  const left = LEFT_BONES.map((n) => bone(root, n));
  const right = RIGHT_BONES.map((n) => bone(root, n));
  const head = bone(root, 'Head');
  const [lUpper, lLower, lHand] = left;
  const [rUpper, rLower, rHand] = right;
  if (!lUpper || !lLower || !lHand || !rUpper || !rLower || !rHand || !head) return null;

  // Stand it in the idle's first frame, remembering how it was.
  const saved = new Map<THREE.Object3D, THREE.Quaternion>();
  const base = new Map<THREE.Object3D, THREE.Quaternion>();
  const held: THREE.KeyframeTrack[] = [];
  const moved = new Set<THREE.Object3D>([lUpper, lLower, rUpper, rLower, head]);
  for (const track of idle.tracks) {
    if (!track.name.endsWith('.quaternion')) continue;
    const b = root.getObjectByName(track.name.slice(0, -'.quaternion'.length));
    if (!b) continue;
    saved.set(b, b.quaternion.clone());
    const q = new THREE.Quaternion().fromArray(track.values, 0);
    base.set(b, q);
    b.quaternion.copy(q);
    if (!moved.has(b)) held.push(new THREE.QuaternionKeyframeTrack(track.name, [0], q.toArray()));
  }
  const hips = bone(root, 'Hips');
  const hipsAt = hips?.position.clone();
  root.updateWorldMatrix(true, true);
  const toWorld = root.matrixWorld.clone();
  const toBody = toWorld.clone().invert();
  const shoulder = rUpper.getWorldPosition(new THREE.Vector3()).applyMatrix4(toBody);
  const reach =
    lUpper.getWorldPosition(new THREE.Vector3()).distanceTo(lLower.getWorldPosition(D)) +
    lLower.getWorldPosition(new THREE.Vector3()).distanceTo(lHand.getWorldPosition(D));
  const frame = { chest: shoulder.y, reach: reach / toWorld.getMaxScaleOnAxis() };
  const path = (kind === 'bandaging' ? bandagingPath : medicinePath)(frame);

  const steps = Math.ceil(path.seconds * FPS);
  const count = steps + 1;
  const times = Array.from({ length: count }, (_, i) => (i / steps) * path.seconds);
  const keys = new Map<THREE.Object3D, number[]>([...moved].map((b) => [b, []]));
  const sideways = new THREE.Vector3(1, 0, 0).transformDirection(toWorld);
  const target = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const reset = (...bones: THREE.Object3D[]) => {
    for (const b of bones) b.quaternion.copy(base.get(b) ?? b.quaternion);
  };
  for (const t of times) {
    reset(lUpper, lLower, rUpper, rLower, head);
    root.updateWorldMatrix(false, true);
    const w = path.left(t, target);
    solveArm(
      lUpper,
      lLower,
      lHand,
      target.applyMatrix4(toWorld).clone(),
      pole
        .copy(path.leftPole)
        .multiplyScalar(frame.reach)
        .add(new THREE.Vector3(0, frame.chest, 0))
        .applyMatrix4(toWorld),
    );
    const v = path.right(t, target);
    solveArm(
      rUpper,
      rLower,
      rHand,
      target.applyMatrix4(toWorld).clone(),
      pole
        .copy(path.rightPole)
        .multiplyScalar(frame.reach)
        .add(new THREE.Vector3(0, frame.chest, 0))
        .applyMatrix4(toWorld),
    );
    // Eased out of the idle's own pose, so it starts and ends exactly there.
    const weigh = (b: THREE.Object3D, by: number) => {
      const solved = b.quaternion.clone();
      b.quaternion.copy(base.get(b) ?? solved).slerp(solved, by);
    };
    weigh(lUpper, w);
    weigh(lLower, w);
    weigh(rUpper, v);
    weigh(rLower, v);
    (head.parent as THREE.Object3D).getWorldQuaternion(P);
    Q.setFromAxisAngle(sideways, path.head(t));
    head.quaternion.premultiply(P.clone().invert().multiply(Q).multiply(P));
    for (const [b, out] of keys)
      out.push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  }

  for (const [b, q] of saved) b.quaternion.copy(q);
  if (hips && hipsAt) hips.position.copy(hipsAt);
  root.updateWorldMatrix(false, true);
  const tracks = [
    ...held,
    ...[...keys].map(
      ([b, values]) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values),
    ),
  ];
  return new THREE.AnimationClip(kind, path.seconds, tracks);
}

let materials: {
  gauze: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  cap: THREE.MeshStandardMaterial;
} | null = null;

function careMaterials() {
  materials ??= {
    gauze: new THREE.MeshStandardMaterial({ color: 0xf1efe8, roughness: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xc8621a, roughness: 0.25 }),
    cap: new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.4 }),
  };
  return materials;
}

/** The props' materials on a hidden mesh, for the game to compile while it loads. */
export function careShaders(): THREE.Object3D {
  const group = new THREE.Group();
  group.visible = false;
  const shape = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  for (const m of Object.values(careMaterials())) group.add(new THREE.Mesh(shape, m));
  return group;
}

/** The roll or bottle in the hand and the band on the arm, on this character's bones. */
export class CareProps {
  private readonly roll = new THREE.Group();
  private readonly band: THREE.Mesh;
  private readonly bottle = new THREE.Group();
  private readonly pill: THREE.Mesh;
  private readonly bandLength: number;

  constructor(root: THREE.Object3D) {
    const m = careMaterials();
    const left = bone(root, 'LeftHand');
    const right = bone(root, 'RightHand');
    const forearm = bone(root, 'LeftForeArm');
    root.updateMatrixWorld(true);
    const unit = 1 / Math.max(1e-6, right?.getWorldScale(new THREE.Vector3()).x ?? 1);
    // Bones run along +x (Rocketbox's rig): the palm is a hand's width along it.
    const rollShape = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.06, 14), m.gauze);
    rollShape.rotation.x = Math.PI / 2;
    this.roll.add(rollShape);
    this.roll.position.set(0.1 * unit, -0.025 * unit, 0);
    this.roll.scale.setScalar(unit);
    right?.add(this.roll);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.075, 12), m.glass);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.029, 0.029, 0.03, 12), m.cap);
    cap.position.y = 0.05;
    this.bottle.add(body, cap);
    this.bottle.position.set(0.09 * unit, 0.035 * unit, 0);
    this.bottle.scale.setScalar(unit);
    left?.add(this.bottle);

    this.pill = new THREE.Mesh(new THREE.CapsuleGeometry(0.007, 0.012, 3, 8), m.cap);
    this.pill.position.set(0.17 * unit, 0, 0.02 * unit);
    this.pill.scale.setScalar(unit);
    right?.add(this.pill);

    // The band: a sleeve along the forearm, wider as the wrapping goes on.
    const hand = left?.position.length() ?? 0.25;
    this.bandLength = hand * 0.5;
    this.band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.046 * unit, 0.05 * unit, 1, 16, 1, true).rotateZ(Math.PI / 2),
      m.gauze,
    );
    this.band.position.x = hand * 0.68;
    forearm?.add(this.band);
    this.show(null);
  }

  /** Which gesture's things to show, `t` seconds into it. */
  show(kind: CareGesture | null, t = 0): void {
    this.roll.visible = kind === 'bandaging';
    this.band.visible = kind === 'bandaging' && t > 0.6;
    if (this.band.visible) {
      const done = Math.min(1, (t - 0.6) / (CARE_SECONDS.bandaging - 1.2));
      this.band.scale.x = this.bandLength * (0.15 + 0.85 * done);
    }
    this.bottle.visible = kind === 'medicine';
    // Gone from the fingers with the toss.
    this.pill.visible = kind === 'medicine' && t < 0.72;
  }
}
