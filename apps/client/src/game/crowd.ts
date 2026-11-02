/**
 * Crowd tier 3 (technical-plan §6): far players as instanced characters with baked animation,
 * instead of one static figure. For each look in the crowd (up to MAX_LOOKS; beyond that, the
 * nearest baked look of the same body) the simplest character (LOD2, dressed as they chose)
 * is loaded once and its skeleton's pose sampled for the idle, walk and run at BAKE_FPS into a
 * float texture of bone matrices (about 100 KB a look). Every part of that character (body,
 * head) is then one InstancedMesh whose vertex shader skins it from the texture, each instance
 * at its own clip and moment, so a far crowd walks and stands about in a few draw calls.
 */
import type { Appearance } from '@fr33world/shared';
import * as THREE from 'three';
import { PRIORITY } from './assets.ts';
import { locomotionClips } from './character/animator.ts';
import { Character, FOOT_LIFT, type Look } from './character/character.ts';

const BAKE_FPS = 20;
const MAX_LOOKS = 12;
/** Instances per look (the crowd beyond the nearest few dozen is at most PROXY_MAX anyway). */
const CAPACITY = 256;

export type Gait = 'idle' | 'walk' | 'run';
const GAITS: readonly Gait[] = ['idle', 'walk', 'run'];

interface ClipRows {
  /** First row of the texture, frames, duration (s), and authored ground speed (m/s). */
  row: number;
  frames: number;
  duration: number;
  speed: number;
}

interface Baked {
  key: number;
  body: Appearance['body'];
  clips: Record<Gait, ClipRows>;
  parts: THREE.InstancedMesh[];
  anim: THREE.InstancedBufferAttribute;
  count: number;
}

/** Where one far player is and what their legs are doing, for this frame. */
export interface CrowdMember {
  look: Look;
  lookKey: number;
  pos: THREE.Vector3;
  yaw: number;
  gait: Gait;
  speed: number;
  /** Their own clock in the cycle (s), kept by the caller between frames. */
  phase: number;
}

export class Crowd {
  private readonly scene: THREE.Scene;
  private readonly baked = new Map<number, Baked>();
  private readonly baking = new Set<number>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly at = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  begin(): void {
    for (const b of this.baked.values()) b.count = 0;
  }

  /**
   * Draws `p` this frame, advancing their phase by `dt`. False while no look fits yet (the
   * caller draws a stand-in); the first call for a new look starts baking it.
   */
  add(p: CrowdMember, dt: number): boolean {
    const b = this.lookFor(p);
    if (!b || b.count >= CAPACITY) return false;
    const clip = b.clips[p.gait];
    // Locomotion plays at the speed they move; the idle at its own pace.
    const rate = clip.speed > 0 ? Math.min(2, p.speed / clip.speed) : 1;
    p.phase = (p.phase + dt * rate) % clip.duration;
    const f = (p.phase / clip.duration) * clip.frames;
    const i = Math.floor(f) % clip.frames;
    b.anim.setXYZ(b.count, clip.row + i, clip.row + ((i + 1) % clip.frames), f - Math.floor(f));
    this.at.copy(p.pos);
    this.at.y += FOOT_LIFT;
    this.q.setFromAxisAngle(this.up, p.yaw);
    this.m.compose(this.at, this.q, this.one);
    for (const part of b.parts) part.setMatrixAt(b.count, this.m);
    b.count += 1;
    return true;
  }

  end(): void {
    for (const b of this.baked.values()) {
      for (const part of b.parts) {
        part.count = b.count;
        part.instanceMatrix.needsUpdate = true;
      }
      b.anim.needsUpdate = true;
    }
  }

  /** Their own look once baked; meanwhile (or past MAX_LOOKS) the closest baked one. */
  private lookFor(p: CrowdMember): Baked | null {
    const own = this.baked.get(p.lookKey);
    if (own) return own;
    if (this.baked.size + this.baking.size < MAX_LOOKS && !this.baking.has(p.lookKey)) {
      this.baking.add(p.lookKey);
      void bake(p.look, p.lookKey).then(
        (b) => {
          this.baking.delete(p.lookKey);
          if (!b) return;
          this.baked.set(b.key, b);
          for (const part of b.parts) this.scene.add(part);
        },
        (e: unknown) => console.warn('crowd bake failed', e),
      );
    }
    let fallback: Baked | null = null;
    for (const b of this.baked.values()) {
      if (b.body === p.look.body) return b;
      fallback ??= b;
    }
    return fallback;
  }
}

/** Loads `look` at LOD2 and bakes its idle, walk and run into instanced parts. */
async function bake(look: Look, key: number): Promise<Baked | null> {
  const c = await Character.load(look, 2, PRIORITY.byDistance(200));
  const root = c.root;
  let hipsRestY = 0;
  root.traverse((o) => {
    if (/Hips$/.test(o.name) && !hipsRestY) hipsRestY = o.position.y;
  });
  const clips = await locomotionClips(hipsRestY);
  if (!clips) return null;
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  if (meshes.length === 0) return null;

  // Rows: every frame of each clip, one after another.
  const rows = {} as Record<Gait, ClipRows>;
  let total = 0;
  for (const g of GAITS) {
    const { clip, speed } = clips[g];
    const frames = Math.max(2, Math.round(clip.duration * BAKE_FPS));
    rows[g] = { row: total, frames, duration: clip.duration, speed };
    total += frames;
  }

  // The character at the origin facing +z (its own height and build stay in the bones).
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  const mixer = new THREE.AnimationMixer(root);
  const textures = meshes.map(
    (mesh) => new Float32Array(mesh.skeleton.bones.length * 4 * 4 * total),
  );
  const bone = new THREE.Matrix4();
  for (const g of GAITS) {
    mixer.stopAllAction();
    const action = mixer.clipAction(clips[g].clip);
    action.play();
    const r = rows[g];
    for (let f = 0; f < r.frames; f += 1) {
      mixer.setTime((f / r.frames) * r.duration);
      root.updateMatrixWorld(true);
      meshes.forEach((mesh, k) => {
        const data = textures[k] as Float32Array;
        const bones = mesh.skeleton.bones;
        const width = bones.length * 4;
        bones.forEach((b, i) => {
          // What three's skinning does: bone × inverse bind × bind matrix, in the root's space.
          bone
            .multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i] as THREE.Matrix4)
            .multiply(mesh.bindMatrix);
          bone.toArray(data, ((r.row + f) * width + i * 4) * 4);
        });
      });
    }
  }
  mixer.stopAllAction();

  const anim = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
  anim.setUsage(THREE.DynamicDrawUsage);
  const parts = meshes.map((mesh, k) => {
    const tex = new THREE.DataTexture(
      textures[k],
      mesh.skeleton.bones.length * 4,
      total,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    tex.needsUpdate = true;
    // The part's own geometry (shared with the cached model) plus the per-instance frames.
    const src = mesh.geometry;
    const geometry = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) geometry.setAttribute(name, attr);
    geometry.setIndex(src.index);
    for (const g of src.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.setAttribute('aCrowd', anim);
    const material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => crowdMaterial(m, tex))
      : crowdMaterial(mesh.material, tex);
    const part = new THREE.InstancedMesh(geometry, material, CAPACITY);
    part.count = 0;
    part.frustumCulled = false;
    part.castShadow = false;
    part.name = `crowd-${key}-${k}`;
    return part;
  });
  return { key, body: look.body, clips: rows, parts, anim, count: 0 };
}

const VERTEX_DECLARATIONS = /* glsl */ `
uniform sampler2D uCrowdBones;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec3 aCrowd;
mat4 crowdBone(float i, float row) {
  ivec2 at = ivec2(int(i) * 4, int(row));
  return mat4(
    texelFetch(uCrowdBones, at, 0),
    texelFetch(uCrowdBones, at + ivec2(1, 0), 0),
    texelFetch(uCrowdBones, at + ivec2(2, 0), 0),
    texelFetch(uCrowdBones, at + ivec2(3, 0), 0));
}
mat4 crowdPose(float row) {
  return skinWeight.x * crowdBone(skinIndex.x, row) + skinWeight.y * crowdBone(skinIndex.y, row)
    + skinWeight.z * crowdBone(skinIndex.z, row) + skinWeight.w * crowdBone(skinIndex.w, row);
}
`;

/** The part's own (dressed) material, skinned from the baked bone texture. */
function crowdMaterial(source: THREE.Material, bones: THREE.DataTexture): THREE.Material {
  const m = source.clone();
  const before = source.onBeforeCompile.bind(source);
  const key = source.customProgramCacheKey.bind(source);
  m.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.uCrowdBones = { value: bones };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `mat4 crowdM = crowdPose(aCrowd.x) * (1.0 - aCrowd.z) + crowdPose(aCrowd.y) * aCrowd.z;
vec3 objectNormal = normalize(mat3(crowdM) * normal);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = (crowdM * vec4(position, 1.0)).xyz;');
  };
  m.customProgramCacheKey = () => `${key()}-crowd`;
  return m;
}
