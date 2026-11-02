#!/usr/bin/env node
/**
 * Retargets the game's animation packs (Mixamo clips on the shared_humanoid_v1 skeleton) onto
 * the Rocketbox skeleton (converted by scripts/blender/convert_rocketbox.py, bones renamed to
 * the Mixamo names). Rocketbox rigs share one configuration, so one target serves every avatar.
 *
 *   node scripts/assets/retarget-rocketbox.mjs <target rig .glb> <pack.glb> <out.glb>
 *
 * Done in world space, so the two rigs' different bone axes don't matter: for each source bone
 * at each sample, its rotation away from rest (world) is applied to the target bone's rest.
 * The rigs rest in different poses (Mixamo in a T, Rocketbox in an A), so each target bone's
 * rest is first turned so its direction (to its child joint) matches the source's. The hips'
 * travel is scaled by the ratio of hip heights. Clips keep their names; 30 samples a second.
 *
 * The standing idles are straightened (owner, 2026-10-29: the source idles stand knees bent and
 * leaning back): their hips, spine and legs stay at the rig's upright rest and the hips don't
 * travel; arms, neck and head keep the clip's movement.
 *
 * Standing clips (UPRIGHT) keep all their movement but are stood up straight: the Rocketbox
 * legs come out of the rest alignment a little forward of the Mixamo rig's, which tipped the
 * whole body back. The clip's average lean (head over the feet, front to back) is measured
 * and the body turned upright about the hips by that much.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const [targetPath, packPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: retarget-rocketbox.mjs <target rig.glb> <pack.glb> <out.glb>');
  process.exit(2);
}
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

// ---- quaternions [x, y, z, w] and vectors -----------------------------------------------
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => {
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n);
};
const vrot = (q, v) => {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q));
  return [p[0], p[1], p[2]];
};
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vnorm = (a) => {
  const n = Math.hypot(...a) || 1;
  return a.map((v) => v / n);
};
/** Shortest rotation taking unit vector a to unit vector b. */
function fromTo(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    const axis = vnorm(Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [a[2], 0, -a[0]]);
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return qnorm([c[0], c[1], c[2], 1 + d]);
}
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((v) => -v) : b;
  d = Math.abs(d);
  if (d > 0.9995) return qnorm(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
}

// ---- skeletons ------------------------------------------------------------------------------
/** The node tree as plain data: name, parent index, rest TRS; in parents-first order. */
function skeleton(doc) {
  const out = [];
  const visit = (node, parent) => {
    const i = out.length;
    out.push({
      name: node.getName(),
      parent,
      t: node.getTranslation(),
      r: node.getRotation(),
      s: node.getScale(),
      node,
    });
    for (const c of node.listChildren()) visit(c, i);
  };
  for (const scene of doc.getRoot().listScenes())
    for (const n of scene.listChildren()) if (!n.getMesh() && !n.getSkin()) visit(n, -1);
  return out;
}

/** World rotations and positions from local ones (parents first). */
function forward(bones, local) {
  const wr = [];
  const wt = [];
  bones.forEach((b, i) => {
    const { r, t } = local(i);
    if (b.parent < 0) {
      wr[i] = r;
      wt[i] = t;
    } else {
      // (Scales are 1 on both rigs.)
      wr[i] = qmul(wr[b.parent], r);
      wt[i] = vadd(wt[b.parent], vrot(wr[b.parent], t));
    }
  });
  return { wr, wt };
}

/** The joint a bone points at, to align rest directions. */
const CHILD = {
  Hips: 'Spine',
  Spine: 'Spine1',
  Spine1: 'Spine2',
  Spine2: 'Neck',
  Neck: 'Head',
  LeftShoulder: 'LeftArm',
  LeftArm: 'LeftForeArm',
  LeftForeArm: 'LeftHand',
  LeftHand: 'LeftHandMiddle1',
  LeftUpLeg: 'LeftLeg',
  LeftLeg: 'LeftFoot',
  LeftFoot: 'LeftToeBase',
};
for (const [k, v] of Object.entries(CHILD))
  if (k.startsWith('Left')) CHILD[k.replace('Left', 'Right')] = v.replace('Left', 'Right');
for (const side of ['Left', 'Right'])
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    CHILD[`${side}Hand${f}1`] = `${side}Hand${f}2`;
    CHILD[`${side}Hand${f}2`] = `${side}Hand${f}3`;
  }

const target = await io.read(targetPath);
const source = await io.read(packPath);
const tBones = skeleton(target);
const sBones = skeleton(source);
const short = (n) => n.replace(/^mixamorig:?/, '');
const sIndex = new Map(sBones.map((b, i) => [short(b.name), i]));
const tIndex = new Map(tBones.map((b, i) => [short(b.name), i]));
const mapped = tBones.map((b) =>
  b.name.startsWith('mixamorig') ? (sIndex.get(short(b.name)) ?? -1) : -1,
);

const sRest = forward(sBones, (i) => ({ r: sBones[i].r, t: sBones[i].t }));
const tRest = forward(tBones, (i) => ({ r: tBones[i].r, t: tBones[i].t }));
const hipsS = sIndex.get('Hips');
const hipsT = tIndex.get('Hips');
const ratio = tRest.wt[hipsT][1] / sRest.wt[hipsS][1];

/** Each mapped target bone's rest turned to point as the source bone does (A · rest). */
/**
 * Only the arms are turned to the source's rest directions (Mixamo rests in a T, Rocketbox in
 * an A). The body, neck, head and legs rest upright on both rigs, so they take the clip's turn
 * from rest as it is: matching bone directions there bent the Rocketbox body into the Mixamo
 * skeleton's S-shaped spine (its spine bones curve back then forward even at rest), so the
 * back arched and the head pushed forward (owner, 2026-10-30).
 */
const ALIGN = /(Shoulder|Arm|ForeArm|Hand)/;
const aligned = tBones.map((b, i) => {
  const s = mapped[i];
  if (s < 0) return null;
  if (!ALIGN.test(short(b.name))) return [0, 0, 0, 1];
  const childName = CHILD[short(b.name)];
  const tc = childName === undefined ? undefined : tIndex.get(childName);
  const sc = childName === undefined ? undefined : sIndex.get(childName);
  let a = [0, 0, 0, 1];
  if (tc !== undefined && sc !== undefined) {
    const dt = vnorm(vsub(tRest.wt[tc], tRest.wt[i]));
    const ds = vnorm(vsub(sRest.wt[sc], sRest.wt[s]));
    a = fromTo(dt, ds);
  } else if (b.parent >= 0 && short(b.name) !== 'Head') {
    // A tip (toes, finger ends): turn with its parent's alignment. Not the head: both rigs
    // rest it facing forward, and the Rocketbox neck leans forward, so straightening the neck
    // would tip the head back.
    a = null;
  }
  return a;
});
tBones.forEach((b, i) => {
  if (mapped[i] >= 0 && aligned[i] === null) aligned[i] = aligned[b.parent] ?? [0, 0, 0, 1];
});
const restAligned = tBones.map((_, i) => (aligned[i] ? qmul(aligned[i], tRest.wr[i]) : null));

// ---- clips ----------------------------------------------------------------------------------
/** A channel's value at time t (linear, slerp for rotations; held at the ends). */
function sample(channel, t) {
  const times = channel.input;
  const out = channel.output;
  const n = channel.size;
  if (t <= times[0]) return Array.from(out.slice(0, n));
  const last = times.length - 1;
  if (t >= times[last]) return Array.from(out.slice(last * n, last * n + n));
  let k = 0;
  while (times[k + 1] < t) k += 1;
  const f = (t - times[k]) / (times[k + 1] - times[k]);
  const a = Array.from(out.slice(k * n, k * n + n));
  const b = Array.from(out.slice((k + 1) * n, (k + 1) * n + n));
  return n === 4 ? slerp(a, b, f) : a.map((v, i) => v + (b[i] - v) * f);
}

const outDoc = new Document();
const buffer = outDoc.createBuffer();
const outScene = outDoc.createScene('rocketbox');
const outNodes = tBones.map((b) =>
  outDoc.createNode(b.name).setTranslation(b.t).setRotation(b.r).setScale(b.s),
);
tBones.forEach((b, i) => {
  if (b.parent < 0) outScene.addChild(outNodes[i]);
  else outNodes[b.parent].addChild(outNodes[i]);
});

/** Angle (radians, about the side axis) of the hips over the feet in a pose: + hips ahead. */
function hipsOverFeet(wt, hips, feet) {
  const fz = (wt[feet[0]][2] + wt[feet[1]][2]) / 2;
  const fy = (wt[feet[0]][1] + wt[feet[1]][1]) / 2;
  return Math.atan2(wt[hips][2] - fz, wt[hips][1] - fy);
}

/**
 * How far the target stands back from the source over the clip (radians): the hips-over-feet
 * angle of the retargeted pose minus the source's, averaged.
 */
function averageLean(rot, hipsPos, frames, sourcePose) {
  const tFeet = ['LeftFoot', 'RightFoot'].map((n) => tIndex.get(n));
  const sFeet = ['LeftFoot', 'RightFoot'].map((n) => sIndex.get(n));
  let sum = 0;
  for (let f = 0; f < frames; f += 1) {
    const pose = forward(tBones, (i) => ({
      r: Array.from(rot[i].subarray(f * 4, f * 4 + 4)),
      t: i === hipsT ? Array.from(hipsPos.subarray(f * 3, f * 3 + 3)) : tBones[i].t,
    }));
    sum += hipsOverFeet(pose.wt, hipsT, tFeet) - hipsOverFeet(sourcePose[f].wt, hipsS, sFeet);
  }
  return sum / frames;
}

const FPS = 30;
const STRAIGHT_CLIPS = new Set(['idle', 'neutral_idle']);
const UPRIGHT = new Set(['standing_idle']);
const STRAIGHT_BONES = new Set(['Hips', 'Spine', 'Spine1', 'Spine2']);
for (const side of ['Left', 'Right'])
  for (const b of ['UpLeg', 'Leg', 'Foot', 'ToeBase']) STRAIGHT_BONES.add(`${side}${b}`);
for (const anim of source.getRoot().listAnimations()) {
  const channels = new Map();
  let duration = 0;
  for (const ch of anim.listChannels()) {
    const s = ch.getSampler();
    const input = s.getInput().getArray();
    const node = sBones.findIndex((b) => b.node === ch.getTargetNode());
    if (node < 0) continue;
    duration = Math.max(duration, input[input.length - 1]);
    channels.set(`${node}:${ch.getTargetPath()}`, {
      input,
      output: s.getOutput().getArray(),
      size: ch.getTargetPath() === 'rotation' ? 4 : 3,
    });
  }
  const frames = Math.max(2, Math.round(duration * FPS) + 1);
  const times = new Float32Array(frames);
  const rot = tBones.map(() => new Float32Array(frames * 4));
  const straight = STRAIGHT_CLIPS.has(anim.getName());
  const hipsPos = new Float32Array(frames * 3);
  const sourcePoses = [];
  for (let f = 0; f < frames; f += 1) {
    const t = Math.min(duration, f / FPS);
    times[f] = t;
    const src = forward(sBones, (i) => ({
      r: channels.has(`${i}:rotation`) ? sample(channels.get(`${i}:rotation`), t) : sBones[i].r,
      t: channels.has(`${i}:translation`)
        ? sample(channels.get(`${i}:translation`), t)
        : sBones[i].t,
    }));
    sourcePoses.push(src);
    // The target, parents first: mapped bones take the source's turn from rest.
    const wr = [];
    tBones.forEach((b, i) => {
      const parentWr = b.parent < 0 ? [0, 0, 0, 1] : wr[b.parent];
      const s = mapped[i];
      let local;
      if (s >= 0) {
        // Straightened idles: these bones keep the upright rest (no turn from it).
        const delta =
          straight && STRAIGHT_BONES.has(short(b.name))
            ? [0, 0, 0, 1]
            : qmul(src.wr[s], qinv(sRest.wr[s]));
        const world = qnorm(qmul(delta, restAligned[i]));
        local = qnorm(qmul(qinv(parentWr), world));
      } else {
        local = b.r;
      }
      wr[i] = qmul(parentWr, local);
      rot[i].set(local, f * 4);
    });
    // The hips' travel, scaled to this rig, in its parent's frame.
    const move = straight ? [0, 0, 0] : vscale(vsub(src.wt[hipsS], sRest.wt[hipsS]), ratio);
    const parent = tBones[hipsT].parent;
    const world = vadd(tRest.wt[hipsT], move);
    const local = parent < 0 ? world : vrot(qinv(tRest.wr[parent]), vsub(world, tRest.wt[parent]));
    hipsPos.set(local, f * 3);
  }
  if (UPRIGHT.has(anim.getName())) {
    const lean = averageLean(rot, hipsPos, frames, sourcePoses);
    // Turn the hips (in the world, about the side axis) by minus the difference, so the hips
    // stand over the feet as the source's do (measured: this sign undoes it).
    const fix = [Math.sin(-lean / 2), 0, 0, Math.cos(-lean / 2)];
    const parent = tBones[hipsT].parent;
    const pw = parent < 0 ? [0, 0, 0, 1] : tRest.wr[parent];
    for (let f = 0; f < frames; f += 1) {
      const local = Array.from(rot[hipsT].subarray(f * 4, f * 4 + 4));
      const world = qmul(pw, local);
      rot[hipsT].set(qnorm(qmul(qinv(pw), qmul(fix, world))), f * 4);
    }
    console.log(`${anim.getName()}: stood up by ${((lean * 180) / Math.PI).toFixed(1)}°`);
  }
  const outAnim = outDoc.createAnimation(anim.getName());
  const input = outDoc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
  tBones.forEach((b, i) => {
    if (mapped[i] < 0) return;
    const output = outDoc.createAccessor().setType('VEC4').setArray(rot[i]).setBuffer(buffer);
    const sampler = outDoc
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation('LINEAR');
    outAnim
      .addSampler(sampler)
      .addChannel(
        outDoc
          .createAnimationChannel()
          .setTargetNode(outNodes[i])
          .setTargetPath('rotation')
          .setSampler(sampler),
      );
  });
  const posOut = outDoc.createAccessor().setType('VEC3').setArray(hipsPos).setBuffer(buffer);
  const posSampler = outDoc
    .createAnimationSampler()
    .setInput(input)
    .setOutput(posOut)
    .setInterpolation('LINEAR');
  outAnim
    .addSampler(posSampler)
    .addChannel(
      outDoc
        .createAnimationChannel()
        .setTargetNode(outNodes[hipsT])
        .setTargetPath('translation')
        .setSampler(posSampler),
    );
  console.log(`${anim.getName()}: ${frames} samples`);
}
await io.write(outPath, outDoc);
console.log(`wrote ${outPath} (hips ratio ${ratio.toFixed(3)})`);
