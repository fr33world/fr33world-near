/**
 * Smoke from damaged cars (Phase 7 damage): grey wisps from the engine bay of a car the server
 * marks DAMAGED, thick dark smoke from a WRECKED one. Every puff of every car is one point in
 * a single Points cloud (one draw call), fading as it rises and spreads.
 */
import * as THREE from 'three';

const MAX = 320;
const LIFE = 2.4;
/** Puffs a second: damaged, wrecked. */
const RATE = { damaged: 7, wrecked: 16 };
/** Only cars this near the camera smoke (m). */
const NEAR = 90;

function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Smoke {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly col = new Float32Array(MAX * 4);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly age = new Float32Array(MAX).fill(LIFE);
  private readonly shade = new Float32Array(MAX);
  private next = 0;
  private wasAlive = false;
  private readonly owed = new Map<number, number>();

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 2.4,
        map: puffTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.points.frustumCulled = false;
    this.points.name = 'car-smoke';
    scene.add(this.points);
  }

  /** A car smoking this frame from `at` (its engine bay); `id` keeps its puff rate steady. */
  emit(id: number, at: THREE.Vector3, wrecked: boolean, dt: number, eye: THREE.Vector3): void {
    if (at.distanceToSquared(eye) > NEAR * NEAR) return;
    let owed = (this.owed.get(id) ?? Math.random()) + dt * (wrecked ? RATE.wrecked : RATE.damaged);
    while (owed >= 1) {
      owed -= 1;
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.pos.set(
        [at.x + (Math.random() - 0.5) * 0.4, at.y, at.z + (Math.random() - 0.5) * 0.4],
        i * 3,
      );
      this.vel.set(
        [(Math.random() - 0.5) * 0.5, 1 + Math.random() * 0.6, (Math.random() - 0.5) * 0.5],
        i * 3,
      );
      this.age[i] = 0;
      this.shade[i] = wrecked ? 0.12 + Math.random() * 0.08 : 0.55 + Math.random() * 0.15;
    }
    this.owed.set(id, owed);
  }

  update(dt: number): void {
    let alive = false;
    for (let i = 0; i < MAX; i += 1) {
      const a = (this.age[i] as number) + dt;
      this.age[i] = a;
      if (a >= LIFE) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      alive = true;
      for (let k = 0; k < 3; k += 1)
        this.pos[i * 3 + k] =
          (this.pos[i * 3 + k] as number) + (this.vel[i * 3 + k] as number) * dt;
      const t = a / LIFE;
      const shade = (this.shade[i] as number) + t * 0.2;
      this.col.set([shade, shade, shade * 1.02, 0.55 * (1 - t) * Math.min(1, a * 6)], i * 4);
    }
    // Always drawn (the faded puffs cost nothing), so its shader is compiled with the city
    // rather than mid-game at the first crash.
    if (!alive && !this.wasAlive) return;
    this.wasAlive = alive;
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
