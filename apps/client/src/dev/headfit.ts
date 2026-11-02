/** Dev only: head-bone-space measurements of faces (for fitting accessories). ?faces=m01,f01 */
import * as THREE from 'three';
import { initTextures, instantiate } from '../game/assets.ts';

const ids = (new URLSearchParams(location.search).get('faces') ?? 'm01').split(',');
initTextures(new THREE.WebGLRenderer());
const out: string[] = [];
const f = (v: THREE.Vector3) =>
  v
    .toArray()
    .map((x) => x.toFixed(3))
    .join(',');
for (const id of ids) {
  const root = await instantiate(`characters/rb_${id}_face.glb`);
  root.updateMatrixWorld(true);
  let head: THREE.Object3D | undefined;
  const marks: string[] = [];
  root.traverse((o) => {
    if (!head && /Head$/.test(o.name) && (o as THREE.Bone).isBone) head = o;
  });
  if (!head) continue;
  const inv = head.matrixWorld.clone().invert();
  root.traverse((o) => {
    if (/(LEye|REye|MNose|MMiddleEyebrow|LEar|MJaw)$/.test(o.name))
      marks.push(
        `${o.name.replace(/.*Bip01_?/, '')}=${f(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv))}`,
      );
  });
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const p = m.geometry.attributes.position as THREE.BufferAttribute;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 1)
      box.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(m.bindMatrix).applyMatrix4(inv));
    marks.push(`${(m.material as THREE.Material).name}: ${f(box.min)} .. ${f(box.max)}`);
  });
  out.push(`${id} | ${marks.join(' | ')}`);
}
(window as Window & { __fit?: string }).__fit = out.join('\n');

// Outfits: the body around the neck, the back and the left wrist, in those bones' frames.
const outfits = (new URLSearchParams(location.search).get('outfits') ?? '')
  .split(',')
  .filter(Boolean);
const bodyOut: string[] = [];
for (const id of outfits) {
  const root = await instantiate(`characters/rb_${id}_outfit.glb`);
  root.updateMatrixWorld(true);
  const bone = (re: RegExp) => {
    let b: THREE.Object3D | undefined;
    root.traverse((o) => {
      if (!b && re.test(o.name) && (o as THREE.Bone).isBone) b = o;
    });
    return b as THREE.Object3D;
  };
  const frames: [string, THREE.Object3D, (v: THREE.Vector3) => boolean][] = [
    // Neck base: a slab from 3 cm below the neck joint to 6 cm above.
    ['neck', bone(/Neck$/), (v) => v.x > -0.03 && v.x < 0.06],
    // Chest/back at the Spine2 joint's height, ±10 cm.
    ['spine2', bone(/Spine2$/), (v) => Math.abs(v.x) < 0.1],
    // The wrist: the last 6 cm of the forearm.
    ['forearm', bone(/LeftForeArm$/), (v) => v.x > 0.2 && v.x < 0.27],
  ];
  const hand = bone(/LeftHand$/);
  const line = [`${id} hand-in-forearm=${f(hand.position)}`];
  for (const [name, b, keep] of frames) {
    const inv = b.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const p = m.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i += 1) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.bindMatrix).applyMatrix4(inv);
        if (keep(v) && (name !== 'forearm' || Math.hypot(v.y, v.z) < 0.08)) box.expandByPoint(v);
      }
    });
    line.push(`${name}: ${f(box.min)} .. ${f(box.max)}`);
  }
  bodyOut.push(line.join(' | '));
}
(window as Window & { __body?: string }).__body = bodyOut.join('\n');
document.body.dataset.ready = '1';
