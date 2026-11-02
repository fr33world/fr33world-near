/**
 * The cars (Phase 7): licensed, unbranded models (scripts/assets/cars.mjs, CC BY 4.0: the
 * generic pack by Comrade1280, the taxi, police cruiser and ambulance by Daniel Zhabotinsky),
 * each a small file of body, lamps and one wheel. Every car of a model is drawn together,
 * instanced: one draw per material per model however many are parked, wheels in two (left and
 * a mirrored right), lamps lit per car by an instance attribute. Their measurements (shared
 * CAR_MODELS) size the driving physics and the collision boxes. Local +z is forward, +x left;
 * the origin is on the ground between the axles.
 */
import { CAR_MODELS, type CarModelSpec } from '@fr33world/shared';
import * as THREE from 'three';
import { loadModel } from '../assets.ts';

export interface CarSpec {
  /** The model's id (shared CAR_MODELS), for its handling and sound (shared HANDLING). */
  id: string;
  name: string;
  length: number;
  width: number;
  wheelRadius: number;
  wheelbase: number;
  track: number;
  /** Chassis collider half-extents and centre height (driving physics). */
  half: [number, number, number];
  centreY: number;
  /** Engine force per driven wheel and top speed (m/s). */
  engine: number;
  topSpeed: number;
}

function toSpec(m: CarModelSpec): CarSpec {
  const [fl, fr, rl, rr] = m.wheels as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  return {
    id: m.id,
    name: m.name,
    length: m.length,
    width: m.width,
    wheelRadius: m.wheelRadius,
    wheelbase: (fl[2] + fr[2] - rl[2] - rr[2]) / 2,
    track: (fl[0] - fr[0] + rl[0] - rr[0]) / 2,
    half: m.half,
    centreY: m.centreY,
    engine: m.engine,
    topSpeed: m.topSpeed,
  };
}

export const CARS: CarSpec[] = CAR_MODELS.map(toSpec);

/** A car in the world as the renderer needs it: where, which model, its lamps. */
export interface CarModel {
  /** Holds the car's pose only (no meshes: the batches draw it). */
  root: THREE.Object3D;
  model: number;
  spec: CarSpec;
  /** Wheel centres in car space: [front-left, front-right, rear-left, rear-right]. */
  wheelCentres: THREE.Vector3[];
  /** Headlights 0–1 and brake lights 0–1, set each frame. */
  head: number;
  brake: number;
  setLights(head: number, brake: number): void;
}

export function buildCar(model: number): CarModel {
  const index = ((model % CAR_MODELS.length) + CAR_MODELS.length) % CAR_MODELS.length;
  const m = CAR_MODELS[index] as CarModelSpec;
  const car: CarModel = {
    root: new THREE.Object3D(),
    model: index,
    spec: CARS[index] as CarSpec,
    wheelCentres: m.wheels.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    head: 0,
    brake: 0,
    setLights(head, brake) {
      car.head = head;
      car.brake = brake;
    },
  };
  return car;
}

/** One kind of part: its geometry and material, as the model file has it. */
interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

interface Asset {
  body: Part[];
  head: Part[];
  tail: Part[];
  wheelLeft: Part[];
  wheelRight: Part[];
}

const GLOW_DECL = /* glsl */ `
#include <common>
#ifdef CAR_LAMP
attribute float aGlow;
varying float vGlow;
#endif
`;

/** A lamp's material: its lens texture glowing as much as the car's `aGlow` says. */
function lampMaterial(source: THREE.Material, colour: number, strength: number): THREE.Material {
  const m = (source as THREE.MeshStandardMaterial).clone();
  m.emissive = new THREE.Color(colour);
  m.emissiveMap = m.map;
  m.emissiveIntensity = strength;
  m.defines = { ...(m.defines ?? {}), CAR_LAMP: '' };
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', GLOW_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow;',
      );
  };
  m.customProgramCacheKey = () => 'car-lamp';
  return m;
}

/** The same geometry mirrored left to right, its triangles turned to face out again. */
function mirrored(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone();
  m.scale(-1, 1, 1);
  const index = m.getIndex();
  if (index) {
    const a = index.array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1] as number;
      a[i + 1] = a[i + 2] as number;
      a[i + 2] = t;
    }
    index.needsUpdate = true;
  }
  return m;
}

/**
 * A copy with positions and normals as plain floats. The files store them as small integers
 * (−1…1, scaled by their node); moved into car space as integers they'd be clamped flat.
 */
function unpacked(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.clone();
  for (const name of ['position', 'normal']) {
    const a = out.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a || a.array instanceof Float32Array) continue;
    const f = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i += 1) {
      f[i * 3] = a.getX(i);
      f[i * 3 + 1] = a.getY(i);
      f[i * 3 + 2] = a.getZ(i);
    }
    out.setAttribute(name, new THREE.BufferAttribute(f, 3));
  }
  return out;
}

const assets = new Map<number, Promise<Asset>>();

/** A model's parts, loaded once (cached like every model). */
export function loadCarAsset(model: number): Promise<Asset> {
  let p = assets.get(model);
  if (!p) {
    const id = (CAR_MODELS[model] as CarModelSpec).id;
    p = loadModel(`cars/${id}.glb`, 5).then((gltf) => {
      const asset: Asset = { body: [], head: [], tail: [], wheelLeft: [], wheelRight: [] };
      gltf.scene.updateMatrixWorld(true);
      for (const group of ['body', 'head', 'tail', 'wheel'] as const) {
        const node = gltf.scene.getObjectByName(group);
        node?.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          // Into the car's own space: the file's nodes carry the compression's scale.
          const geometry = unpacked(mesh.geometry).applyMatrix4(mesh.matrixWorld);
          const material = mesh.material as THREE.Material;
          if (group === 'head')
            asset.head.push({ geometry, material: lampMaterial(material, 0xfff1d8, 2.4) });
          else if (group === 'tail')
            asset.tail.push({ geometry, material: lampMaterial(material, 0xff2a18, 2) });
          else if (group === 'wheel') {
            asset.wheelLeft.push({ geometry, material });
            asset.wheelRight.push({ geometry: mirrored(geometry), material });
          } else asset.body.push({ geometry, material });
        });
      }
      return asset;
    });
    assets.set(model, p);
  }
  return p;
}

/** Every car of one model, drawn instanced. */
export class CarBatch {
  private readonly scene: THREE.Scene;
  private capacity: number;
  private asset: Asset | null = null;
  private body: THREE.InstancedMesh[] = [];
  private lamps: {
    mesh: THREE.InstancedMesh;
    glow: THREE.InstancedBufferAttribute;
    tail: boolean;
  }[] = [];
  private left: THREE.InstancedMesh[] = [];
  private right: THREE.InstancedMesh[] = [];
  private count = 0;
  /** Resolves once the model is in the scene. */
  readonly ready: Promise<void>;

  constructor(scene: THREE.Scene, model: number, capacity = 32) {
    this.scene = scene;
    this.capacity = capacity;
    this.ready = loadCarAsset(model).then((a) => {
      this.asset = a;
      this.build();
    });
  }

  private build() {
    const a = this.asset;
    if (!a) return;
    for (const m of [...this.body, ...this.left, ...this.right, ...this.lamps.map((l) => l.mesh)]) {
      this.scene.remove(m);
      m.dispose();
    }
    const make = (p: Part, count: number, shadow: boolean) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, count);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      this.scene.add(m);
      return m;
    };
    this.body = a.body.map((p) => make(p, this.capacity, true));
    // Wheels sit in the body's shadow: they cast none of their own (two draws fewer a model).
    this.left = a.wheelLeft.map((p) => make(p, this.capacity * 2, false));
    this.right = a.wheelRight.map((p) => make(p, this.capacity * 2, false));
    this.lamps = [
      ...a.head.map((p) => ({ p, tail: false })),
      ...a.tail.map((p) => ({ p, tail: true })),
    ].map(({ p, tail }) => {
      const glow = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
      const geometry = p.geometry.clone();
      geometry.setAttribute('aGlow', glow);
      const mesh = make({ geometry, material: p.material }, this.capacity, false);
      return { mesh, glow, tail };
    });
  }

  begin(): void {
    this.count = 0;
  }

  /** Adds a car this frame: its body matrix, lamps (0–1), and its four wheel matrices. */
  add(body: THREE.Matrix4, head: number, brake: number, wheels: THREE.Matrix4[]): void {
    if (!this.asset) return;
    if (this.count >= this.capacity) {
      this.capacity *= 2;
      this.build();
      return;
    }
    const i = this.count;
    for (const m of this.body) m.setMatrixAt(i, body);
    for (const l of this.lamps) {
      l.mesh.setMatrixAt(i, body);
      l.glow.setX(i, l.tail ? Math.max(brake, head * 0.45) : head);
    }
    wheels.forEach((w, k) => {
      // FL and RL (k 0, 2) use the model's wheel; FR and RR (1, 3) its mirror image. Two of
      // each side a car: front then rear.
      const meshes = k % 2 === 0 ? this.left : this.right;
      for (const m of meshes) m.setMatrixAt(i * 2 + (k >> 1), w);
    });
    this.count += 1;
  }

  end(): void {
    // No cars of this model: hidden, so it costs no draw calls at all.
    const any = this.count > 0;
    for (const m of this.body) {
      m.count = this.count;
      m.visible = any;
      m.instanceMatrix.needsUpdate = any;
    }
    for (const l of this.lamps) {
      l.mesh.count = this.count;
      l.mesh.visible = any;
      l.mesh.instanceMatrix.needsUpdate = any;
      l.glow.needsUpdate = any;
    }
    for (const m of [...this.left, ...this.right]) {
      m.count = this.count * 2;
      m.visible = any;
      m.instanceMatrix.needsUpdate = any;
    }
  }
}
