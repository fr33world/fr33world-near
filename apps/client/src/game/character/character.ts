/**
 * A skinned character from the shared appearance: a Rocketbox outfit (body and clothes) with a
 * Rocketbox face (head and hair) bound to its skeleton by bone name, an animator, and the
 * player's choices drawn in the materials' shaders (no extra downloads): the skin moved to the
 * chosen tone, clothes regions recoloured, facial hair drawn on the face, height and build on
 * the skeleton. Each part has a mask over its texture (scripts/blender/rocketbox_masks.py:
 * outfit R top, G bottom, B shoes, A skin; face R beard, G goatee, B moustache, A skin). LOD
 * level 0–2 picks the detail files (technical-plan §6: full detail near, simpler further away).
 */
import {
  type Appearance,
  CLOTHES_COLOURS,
  FACIAL_HAIR,
  ROCKETBOX_FACES,
  ROCKETBOX_OUTFITS,
  SKIN_TONES,
  type Gear,
  NO_GEAR,
} from '@fr33world/shared';
import * as THREE from 'three';
import { instantiate } from '../assets.ts';
import { measureHead, trimHair, wear } from './accessories.ts';
import { Animator, loadAnimationPack } from './animator.ts';
import { CARE_SECONDS, type CareGesture, CareProps } from './patchup.ts';

/** How a character looks (the shared appearance), and a faction's clothes over it. */
export type Look = Appearance & {
  uniform?: readonly [string, string, string] | null;
  /** A real uniform (shared RANK_UNIFORMS) in place of their outfit. */
  dress?: string | null;
};

/**
 * How far to raise a character above the body position it's drawn at: the physics capsule
 * rests 0.9 cm into the sidewalk, and the Rocketbox soles sit on the rig's origin.
 */
export const FOOT_LIFT = 0.01;

/** Facial hair styles: how much of each mask area (beard, goatee, moustache) and how dense. */
const FACIAL: Record<(typeof FACIAL_HAIR)[number], [number, number, number, number]> = {
  none: [0, 0, 0, 0],
  stubble: [1, 1, 1, 0.45],
  goatee: [0, 1, 0, 0.92],
  moustache: [0, 0, 1, 0.92],
  beard: [1, 1, 1, 0.92],
};
const FACIAL_HAIR_COLOUR = new THREE.Color().setRGB(0.07, 0.055, 0.045, THREE.SRGBColorSpace);

/** The `i`th choice (the first if out of range). */
const pick = (list: readonly string[], i: number): string => list[i] ?? list[0] ?? '';

const lodSuffix = (level: number) => (level === 0 ? '' : `.lod${level}`);

/**
 * Each avatar's skin colour (sRGB) and its outfit's top, bottom and shoes mean luminance
 * (linear), from the build (characters/rocketbox.json).
 */
type Tones = Record<string, { skin: number[]; cloth?: number[] }>;
let manifest: Promise<Tones> | null = null;
function tonesOf(): Promise<Tones> {
  manifest ??= fetch('/assets/characters/rocketbox.json')
    .then((r) => r.json() as Promise<Tones>)
    .catch(() => ({}));
  return manifest;
}

const masks = new Map<string, THREE.Texture>();
function mask(file: string): THREE.Texture {
  let t = masks.get(file);
  if (!t) {
    t = new THREE.TextureLoader().load(`/assets/characters/${file}`);
    // Like the glTF's own textures (its UVs are flipped instead).
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    masks.set(file, t);
  }
  return t;
}

export class Character {
  readonly root: THREE.Object3D;
  readonly animator: Animator | null;
  /** What's in the hands while patching up, and how far into it. */
  private props: CareProps | null = null;
  private patching: CareGesture | null = null;
  private patchingFor = 0;

  private constructor(root: THREE.Object3D, animator: Animator | null) {
    this.root = root;
    this.animator = animator;
  }

  /** `gear`: what they wear besides the outfit (accessories.ts). */
  static async load(
    look: Look,
    level = 0,
    priority?: number,
    gear: Gear = NO_GEAR,
  ): Promise<Character> {
    const suffix = lodSuffix(level);
    const face = pick(ROCKETBOX_FACES[look.body], look.face);
    const outfit = look.dress ?? pick(ROCKETBOX_OUTFITS[look.body], look.outfit);
    const [root, head, pack, tones] = await Promise.all([
      instantiate(`characters/rb_${outfit}_outfit${suffix}.glb`, priority),
      instantiate(`characters/rb_${face}_face${suffix}.glb`, priority),
      loadAnimationPack(),
      tonesOf(),
    ]);
    dress(root, head, look, { face, outfit, tones });
    // The face's own head, measured before it joins the outfit, for fitting hats and glasses.
    const fit = measureHead(head);
    if (fit && gear.head > 0) trimHair(head, fit);
    attachToSkeleton(root, head);
    wear(root, gear, fit, look.body === 'female');
    let hipsRestY = 0;
    root.traverse((o) => {
      if (/Hips$/.test(o.name) && !hipsRestY) hipsRestY = o.position.y;
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        // Bind-pose bounds lag the animated pose, so never cull a character by them.
        o.frustumCulled = false;
        o.castShadow = true;
      }
    });
    return new Character(root, Animator.create(root, pack, hipsRestY));
  }

  /** `angle`: direction of travel relative to facing (moveAngle), for armed movement. */
  update(dt: number, speed: number, gait?: 'walk' | 'run', angle?: number): void {
    this.animator?.update(dt, speed, gait, angle);
    if (!this.patching) return;
    this.patchingFor += dt;
    const over = this.patchingFor >= CARE_SECONDS[this.patching];
    this.props?.show(over ? null : this.patching, this.patchingFor);
    if (over) this.patching = null;
  }

  /** An emote by its clip; patching up has its own clips and things in the hands. */
  emote(clip: string, loop: boolean): void {
    if (clip === 'bandaging' || clip === 'medicine') void this.patchUp(clip);
    else void this.animator?.play(clip, loop);
  }

  /** The bandage or the medicine, with the roll or bottle in hand. */
  async patchUp(kind: CareGesture): Promise<void> {
    if (!(await this.animator?.patchUp(kind))) return;
    this.props ??= new CareProps(this.root);
    this.patching = kind;
    this.patchingFor = 0;
  }

  /** Puts a held item (the pistol) in the right hand, at real size whatever the rig's scale. */
  holdInRightHand(item: THREE.Object3D): boolean {
    // GLTFLoader strips ':' from node names, so the bone is 'mixamorigRightHand'.
    let hand: THREE.Object3D | undefined;
    this.root.traverse((o) => {
      if (!hand && /RightHand$/.test(o.name)) hand = o;
    });
    if (!hand) return false;
    // The grip the Mixamo hand had, carried onto the Rocketbox hand (its bone runs along +x)
    // through the retarget's rest alignment, so it matches the pistol clips.
    item.position.set(0.091, 0.021, 0.015);
    item.rotation.set(-0.839 * Math.PI, 0.454 * Math.PI, 0.674 * Math.PI);
    // Round the barrel: the grip goes down into the palm, the sights on top.
    item.rotateZ(Math.PI);
    this.root.updateMatrixWorld(true);
    const s = new THREE.Vector3();
    hand.getWorldScale(s);
    item.scale.setScalar(1 / Math.max(1e-6, s.x));
    hand.add(item);
    return true;
  }
}

/** Moves every skinned mesh of `part` onto `body`, rebinding it to the body's bones by name. */
export function attachToSkeleton(body: THREE.Object3D, part: THREE.Object3D): void {
  const bones = new Map<string, THREE.Bone>();
  body.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
  });
  const meshes: THREE.SkinnedMesh[] = [];
  part.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  for (const mesh of meshes) {
    const mapped = mesh.skeleton.bones.map((b) => bones.get(b.name) ?? b);
    const skeleton = new THREE.Skeleton(mapped, mesh.skeleton.boneInverses);
    body.add(mesh);
    mesh.bind(skeleton, mesh.bindMatrix);
  }
}

const linear = (srgb: readonly number[]) =>
  new THREE.Color().setRGB(srgb[0] ?? 0.6, srgb[1] ?? 0.45, srgb[2] ?? 0.35, THREE.SRGBColorSpace);
const hex = (h: string) => new THREE.Color(h);

/**
 * The player's choices in the two parts' materials (cloned: the cached models stay clean).
 * Skin moves from each part's own tone to the chosen one (or the face's, so the hands match
 * it); clothes regions take a chosen colour; the face gets its facial hair.
 */
function dress(
  outfitRoot: THREE.Object3D,
  faceRoot: THREE.Object3D,
  look: Look,
  ids: { face: string; outfit: string; tones: Tones },
): void {
  const faceTone = linear(ids.tones[ids.face]?.skin ?? []);
  const target = look.skin === 0 ? faceTone : hex(SKIN_TONES[look.skin - 1] ?? '#c68e6a');
  const cloth = ids.tones[ids.outfit]?.cloth ?? [];
  const clothes = [look.top, look.bottom, look.shoes].map((c, i) => {
    const uniform = look.uniform?.[i];
    if (uniform) return tint(hex(uniform), cloth[i] ?? 0.2);
    return c === 0 ? null : tint(hex(CLOTHES_COLOURS[c - 1] ?? '#7d7f84'), cloth[i] ?? 0.2);
  });
  const facial = FACIAL[FACIAL_HAIR[look.facialHair] ?? 'none'];
  outfitRoot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !/_body$/.test((mesh.material as THREE.Material).name)) return;
    mesh.material = patched(mesh.material as THREE.MeshStandardMaterial, 'outfit', {
      uMask: mask(`rb_${ids.outfit}_outfit.mask.png`),
      uSkinFrom: linear(ids.tones[ids.outfit]?.skin ?? []),
      uSkinTo: target,
      uTint0: clothes[0] ?? NO_TINT,
      uTint1: clothes[1] ?? NO_TINT,
      uTint2: clothes[2] ?? NO_TINT,
    });
  });
  faceRoot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !/_head$/.test((mesh.material as THREE.Material).name)) return;
    mesh.material = patched(mesh.material as THREE.MeshStandardMaterial, 'face', {
      uMask: mask(`rb_${ids.face}_face.mask.png`),
      uSkinFrom: faceTone,
      uSkinTo: target,
      uFacial: new THREE.Vector4(...facial),
      uFacialColour: FACIAL_HAIR_COLOUR,
    });
  });
}

/** A clothes colour, with the region's own mean luminance in w (0: left as it is). */
const tint = (c: THREE.Color, lum: number) => new THREE.Vector4(c.r, c.g, c.b, Math.max(lum, 0.01));
const NO_TINT = new THREE.Vector4(0, 0, 0, 0);

const DECLARATIONS = /* glsl */ `
uniform sampler2D uMask;
uniform vec3 uSkinFrom;
uniform vec3 uSkinTo;
#ifdef RB_OUTFIT
uniform vec4 uTint0;
uniform vec4 uTint1;
uniform vec4 uTint2;
vec3 rbTint(vec3 c, float lum, vec4 t, float w) {
  if (t.a <= 0.0 || w < 0.01) return c;
  // The fabric's light and shade (relative to the region's mean) in the new colour.
  return mix(c, clamp(t.rgb * min(lum / t.a, 2.5), 0.0, 1.0), w);
}
#endif
#ifdef RB_FACE
uniform vec4 uFacial;
uniform vec3 uFacialColour;
#endif
`;

const BODY = /* glsl */ `
{
  vec4 rbMask = texture2D(uMask, vMapUv);
  vec3 rbC = diffuseColor.rgb;
  float rbL = dot(rbC, vec3(0.2126, 0.7152, 0.0722));
  // Skin: the chosen tone, keeping the texture's light and shade.
  float rbFrom = max(dot(uSkinFrom, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  // (Contrast eased a little, and scaled down rather than clipped, so light tones don't
  // burn out to white.)
  vec3 rbSkin = uSkinTo * pow(rbL / rbFrom, 0.8);
  rbC = mix(rbC, rbSkin / max(1.0, max(rbSkin.r, max(rbSkin.g, rbSkin.b))), rbMask.a);
#ifdef RB_OUTFIT
  float rbCloth = 1.0 - rbMask.a;
  rbC = rbTint(rbC, rbL, uTint0, rbMask.r * rbCloth);
  rbC = rbTint(rbC, rbL, uTint1, rbMask.g * rbCloth);
  rbC = rbTint(rbC, rbL, uTint2, rbMask.b * rbCloth);
#endif
#ifdef RB_FACE
  // Facial hair: short dark hairs over the style's areas, sparse for stubble, dense for a beard.
  float rbArea = max(max(rbMask.r * uFacial.x, rbMask.g * uFacial.y), rbMask.b * uFacial.z);
  // Fine strands running down the face (the noise stretched along v).
  float rbN = fract(sin(dot(floor(vMapUv * vec2(2048.0, 700.0)), vec2(12.9898, 78.233))) * 43758.5453);
  float rbHair = rbArea * uFacial.w * mix(0.55, 1.0, rbN);
  rbC = mix(rbC, uFacialColour * (0.75 + 0.5 * rbN), clamp(rbHair, 0.0, 1.0));
#endif
  diffuseColor.rgb = rbC;
}
`;

/** A copy of `material` whose shader applies the part's mask with these uniforms. */
function patched(
  material: THREE.MeshStandardMaterial,
  kind: 'outfit' | 'face',
  uniforms: Record<string, THREE.Texture | THREE.Color | THREE.Vector4>,
): THREE.MeshStandardMaterial {
  const m = material.clone();
  m.defines = { ...(m.defines ?? {}), [kind === 'outfit' ? 'RB_OUTFIT' : 'RB_FACE']: '' };
  m.onBeforeCompile = (shader) => {
    for (const [k, v] of Object.entries(uniforms)) shader.uniforms[k] = { value: v };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECLARATIONS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${BODY}`);
  };
  m.customProgramCacheKey = () => `rocketbox-${kind}`;
  return m;
}
