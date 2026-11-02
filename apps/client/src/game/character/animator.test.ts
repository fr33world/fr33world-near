import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Animator, halfClip, moveAngle, pickMove } from './animator.ts';
import { bakeGesture, solveArm } from './patchup.ts';

const DEG = Math.PI / 180;

describe('moveAngle', () => {
  it('is 0 forward, +90° to the left, ±180° backwards', () => {
    // Facing +z (yaw 0): +x is the body's left.
    expect(moveAngle(0, 2, 0)).toBeCloseTo(0);
    expect(moveAngle(2, 0, 0)).toBeCloseTo(90 * DEG);
    expect(moveAngle(-2, 0, 0)).toBeCloseTo(-90 * DEG);
    expect(Math.abs(moveAngle(0, -2, 0))).toBeCloseTo(180 * DEG);
    // Facing +x (yaw 90°): moving +x is forward.
    expect(moveAngle(3, 0, 90 * DEG)).toBeCloseTo(0);
  });
});

describe('pickMove', () => {
  it('faces where it goes without an angle', () => {
    expect(pickMove(null, 0, 'run')).toBe('idle');
    expect(pickMove(null, 5, 'run')).toBe('run');
    expect(pickMove(null, 1.5, 'walk')).toBe('walk');
  });

  it('picks forward, back and strafes from the angle while armed', () => {
    expect(pickMove('idle', 5, 'run', 10 * DEG)).toBe('run');
    expect(pickMove('idle', 5, 'run', 170 * DEG)).toBe('run_back');
    expect(pickMove('idle', 1.5, 'walk', -175 * DEG)).toBe('walk_back');
    expect(pickMove('idle', 5, 'run', 90 * DEG)).toBe('strafe_left');
    expect(pickMove('idle', 5, 'run', -80 * DEG)).toBe('strafe_right');
  });
});

describe('halfClip', () => {
  it('splits upper body from hips and legs', () => {
    const clip = new THREE.AnimationClip('c', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0], [0, 0, 0, 1]),
      new THREE.QuaternionKeyframeTrack('mixamorigRightHandIndex1.quaternion', [0], [0, 0, 0, 1]),
      new THREE.QuaternionKeyframeTrack('mixamorigLeftUpLeg.quaternion', [0], [0, 0, 0, 1]),
      new THREE.VectorKeyframeTrack('mixamorigHips.position', [0], [0, 1, 0]),
    ]);
    expect(halfClip(clip, true).tracks.map((t) => t.name)).toEqual([
      'mixamorigSpine.quaternion',
      'mixamorigRightHandIndex1.quaternion',
    ]);
    expect(halfClip(clip, false).tracks.map((t) => t.name)).toEqual([
      'mixamorigLeftUpLeg.quaternion',
      'mixamorigHips.position',
    ]);
  });
});

describe('Animator layers', () => {
  const rot = (axis: THREE.Vector3, angle: number) =>
    new THREE.Quaternion().setFromAxisAngle(axis, angle).toArray();
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const pose = (name: string, spine: number[], leg: number[]) =>
    new THREE.AnimationClip(name, 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 1], [...spine, ...spine]),
      new THREE.QuaternionKeyframeTrack('mixamorigLeftUpLeg.quaternion', [0, 1], [...leg, ...leg]),
    ]);

  function rig() {
    const root = new THREE.Object3D();
    const hips = new THREE.Bone();
    hips.name = 'mixamorigHips';
    const spine = new THREE.Bone();
    spine.name = 'mixamorigSpine';
    const leg = new THREE.Bone();
    leg.name = 'mixamorigLeftUpLeg';
    hips.add(spine, leg);
    root.add(hips);
    const still = [0, 0, 0, 1];
    const clips = [
      pose('idle', still, still),
      pose('running', rot(X, 0.5), rot(X, 0.8)),
      pose('pistol_fire', rot(Z, 1), still),
    ];
    const animator = Animator.create(root, { path: 'test', clips, hipsRestY: 1 }, 1);
    if (!animator) throw new Error('no animator');
    return { animator, spine, leg };
  }

  const angleAbout = (q: THREE.Quaternion, axis: THREE.Vector3) =>
    2 * Math.atan2(new THREE.Vector3(q.x, q.y, q.z).dot(axis), q.w);

  it('fires with the upper body while the legs keep running', async () => {
    const { animator, spine, leg } = rig();
    for (let i = 0; i < 30; i += 1) animator.update(1 / 30, 3.6, 'run');
    expect(angleAbout(leg.quaternion, X)).toBeCloseTo(0.8, 2);
    expect(angleAbout(spine.quaternion, X)).toBeCloseTo(0.5, 2);

    animator.setAiming(true);
    await Promise.resolve();
    for (let i = 0; i < 10; i += 1) animator.update(1 / 30, 3.6, 'run');
    // The spine is the overlay's; the legs are still the run's.
    expect(angleAbout(spine.quaternion, Z)).toBeCloseTo(1, 2);
    expect(angleAbout(leg.quaternion, X)).toBeCloseTo(0.8, 2);

    animator.setAiming(false);
    for (let i = 0; i < 15; i += 1) animator.update(1 / 30, 3.6, 'run');
    expect(angleAbout(spine.quaternion, X)).toBeCloseTo(0.5, 2);
  });
});

describe('patching up', () => {
  /** A shoulder, elbow, wrist chain hanging from a chest, on a turned body. */
  function rig() {
    const root = new THREE.Group();
    root.rotation.y = 0.7;
    root.position.set(3, 0, -2);
    const add = (parent: THREE.Object3D, name: string, x: number, y: number) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, 0);
      parent.add(b);
      return b;
    };
    const hips = add(root, 'mixamorigHips', 0, 0.95);
    const head = add(hips, 'mixamorigHead', 0, 0.65);
    const arm = (side: string, x: number) => {
      const upper = add(hips, `mixamorig${side}Arm`, x, 0.45);
      const lower = add(upper, `mixamorig${side}ForeArm`, 0, -0.28);
      const hand = add(lower, `mixamorig${side}Hand`, 0, -0.26);
      return { upper, lower, hand };
    };
    const left = arm('Left', 0.2);
    const right = arm('Right', -0.2);
    root.updateWorldMatrix(true, true);
    return { root, hips, head, left, right };
  }

  it('brings the hand to a target in reach, the elbow bent towards the pole', () => {
    const { root, left } = rig();
    const target = new THREE.Vector3(0.05, 1.2, 0.3).applyMatrix4(root.matrixWorld);
    const pole = new THREE.Vector3(1, 1, -1).applyMatrix4(root.matrixWorld);
    solveArm(left.upper, left.lower, left.hand, target, pole);
    expect(left.hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(0.002);
    const elbow = left.lower.getWorldPosition(new THREE.Vector3());
    const line = target
      .clone()
      .add(left.upper.getWorldPosition(new THREE.Vector3()))
      .divideScalar(2);
    expect(elbow.distanceTo(pole)).toBeLessThan(line.distanceTo(pole));
  });

  it('reaches as far as it can for a target out of reach', () => {
    const { root, left } = rig();
    const target = new THREE.Vector3(3, 1.4, 2).applyMatrix4(root.matrixWorld);
    solveArm(left.upper, left.lower, left.hand, target, new THREE.Vector3(0, 0, 0));
    const s = left.upper.getWorldPosition(new THREE.Vector3());
    expect(left.hand.getWorldPosition(new THREE.Vector3()).distanceTo(s)).toBeCloseTo(0.54, 1);
  });

  it('bakes a clip that starts and ends in the idle, and leaves the skeleton alone', () => {
    const { root, hips, head, left, right } = rig();
    const bones = [hips, head, left.upper, left.lower, left.hand, right.upper, right.lower];
    const idle = new THREE.AnimationClip(
      'standing_idle',
      1,
      bones.map(
        (b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, [0], [0, 0, 0, 1]),
      ),
    );
    const before = left.upper.quaternion.clone();
    for (const kind of ['bandaging', 'medicine'] as const) {
      const clip = bakeGesture(root, idle, kind);
      if (!clip) throw new Error('nothing baked');
      const track = clip.tracks.find((t) => t.name === `${left.upper.name}.quaternion`);
      if (!track) throw new Error('no arm track');
      const first = new THREE.Quaternion().fromArray(track.values, 0);
      const last = new THREE.Quaternion().fromArray(track.values, track.values.length - 4);
      expect(first.angleTo(before)).toBeLessThan(1e-3);
      expect(last.angleTo(before)).toBeLessThan(1e-3);
      // And moves in between.
      const mid = new THREE.Quaternion().fromArray(track.values, (track.times.length >> 1) * 4);
      expect(mid.angleTo(before)).toBeGreaterThan(0.2);
    }
    expect(left.upper.quaternion.angleTo(before)).toBeLessThan(1e-6);
  });

  it('bakes nothing for a skeleton without arms', () => {
    expect(bakeGesture(new THREE.Group(), new THREE.AnimationClip('i', 1, []), 'medicine')).toBe(
      null,
    );
  });
});
