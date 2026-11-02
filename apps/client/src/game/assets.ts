/**
 * Model streaming, adapted from the earlier FreeWorld client. Files are optimised GLBs
 * (meshopt geometry decoded in workers, KTX2 textures that stay compressed on the GPU;
 * scripts/assets/optimize.mjs). Requests go through a priority queue
 * with a few downloads in flight, so the player's own character never waits behind a crowd
 * of distant strangers. Lower priority numbers load first.
 */
import type * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let ktx2: KTX2Loader | null = null;

/**
 * Enables KTX2 textures: picks the compressed format this GPU supports (ASTC, BC7, ETC2…).
 * Call once with the renderer before loading models. The Basis transcoder (public/basis/,
 * copied from three's examples) runs in workers.
 */
export function initTextures(renderer: THREE.WebGLRenderer): KTX2Loader {
  if (!ktx2) {
    ktx2 = new KTX2Loader().setTranscoderPath('/basis/').setWorkerLimit(2).detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }
  return ktx2;
}

/** The KTX2 loader, once initTextures has made it. */
export const ktx2Loader = (): KTX2Loader | null => ktx2;

const MAX_IN_FLIGHT = 3;

export const PRIORITY = {
  self: 0,
  /** Others are queued by distance in metres, offset so the player always wins. */
  byDistance: (metres: number) => 1 + Math.max(0, metres),
} as const;

interface Pending {
  path: string;
  priority: number;
  resolve: (g: GLTF) => void;
  reject: (e: unknown) => void;
}

const cache = new Map<string, Promise<GLTF>>();
const queued = new Map<string, Pending>();
let inFlight = 0;
let workersStarted = false;

function pump(): void {
  if (!workersStarted && typeof Worker !== 'undefined') {
    // Aliased so the hooks lint rule doesn't mistake `useWorkers` for a React hook.
    const startWorkers = MeshoptDecoder.useWorkers.bind(MeshoptDecoder);
    startWorkers(2);
    workersStarted = true;
  }
  while (inFlight < MAX_IN_FLIGHT && queued.size > 0) {
    let next: Pending | undefined;
    for (const p of queued.values()) if (!next || p.priority < next.priority) next = p;
    if (!next) return;
    queued.delete(next.path);
    inFlight += 1;
    const job = next;
    loader
      .loadAsync(`/assets/${job.path}`)
      .then(job.resolve, job.reject)
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

/** Loads (once) and caches a model. */
export function loadModel(path: string, priority = 100): Promise<GLTF> {
  const waiting = queued.get(path);
  if (waiting) waiting.priority = Math.min(waiting.priority, priority);
  let p = cache.get(path);
  if (!p) {
    p = new Promise<GLTF>((resolve, reject) => {
      queued.set(path, { path, priority, resolve, reject });
    });
    // A failed load must not poison the cache: the next caller retries.
    p.catch(() => cache.delete(path));
    cache.set(path, p);
    pump();
  }
  return p;
}

/** A fresh, independently animatable copy of a loaded model (skeletons are cloned too). */
export async function instantiate(path: string, priority?: number): Promise<THREE.Object3D> {
  const gltf = await loadModel(path, priority);
  return cloneSkinned(gltf.scene);
}
