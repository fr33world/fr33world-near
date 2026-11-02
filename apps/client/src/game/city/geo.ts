/**
 * Accumulates quads and boxes into one BufferGeometry with world-space UVs, so a whole layer
 * of the city (all roads, all sidewalks, all buildings of a style) is a single draw call.
 */
import * as THREE from 'three';

export class GeoBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];
  private readonly extra = new Map<string, { size: number; data: number[]; value: number[] }>();

  /** Declares a per-vertex attribute; `set` changes the value applied to following vertices. */
  attribute(name: string, size: number, initial: number[]): this {
    this.extra.set(name, { size, data: [], value: initial });
    return this;
  }

  set(name: string, value: number[]): this {
    const a = this.extra.get(name);
    if (!a) throw new Error(`unknown attribute ${name}`);
    a.value = value;
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  private vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    for (const a of this.extra.values()) a.data.push(...a.value);
  }

  /** Quad from four corners (counter-clockwise seen from the normal side). */
  quad(
    a: THREE.Vector3Like,
    b: THREE.Vector3Like,
    c: THREE.Vector3Like,
    d: THREE.Vector3Like,
    n: THREE.Vector3Like,
    uvs: [number, number, number, number, number, number, number, number],
  ): this {
    const i = this.vertexCount;
    this.vertex(a.x, a.y, a.z, n.x, n.y, n.z, uvs[0], uvs[1]);
    this.vertex(b.x, b.y, b.z, n.x, n.y, n.z, uvs[2], uvs[3]);
    this.vertex(c.x, c.y, c.z, n.x, n.y, n.z, uvs[4], uvs[5]);
    this.vertex(d.x, d.y, d.z, n.x, n.y, n.z, uvs[6], uvs[7]);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }

  /** Triangle (counter-clockwise seen from the normal side). */
  tri(
    a: THREE.Vector3Like,
    b: THREE.Vector3Like,
    c: THREE.Vector3Like,
    n: THREE.Vector3Like,
    uvs: [number, number, number, number, number, number],
  ): this {
    const i = this.vertexCount;
    this.vertex(a.x, a.y, a.z, n.x, n.y, n.z, uvs[0], uvs[1]);
    this.vertex(b.x, b.y, b.z, n.x, n.y, n.z, uvs[2], uvs[3]);
    this.vertex(c.x, c.y, c.z, n.x, n.y, n.z, uvs[4], uvs[5]);
    this.idx.push(i, i + 1, i + 2);
    return this;
  }

  /** Horizontal rectangle at height y facing up, UVs = world xz / tile. */
  flat(x0: number, z0: number, x1: number, z1: number, y: number, tile = 1): this {
    return this.quad(
      { x: x0, y, z: z1 },
      { x: x1, y, z: z1 },
      { x: x1, y, z: z0 },
      { x: x0, y, z: z0 },
      { x: 0, y: 1, z: 0 },
      [x0 / tile, z1 / tile, x1 / tile, z1 / tile, x1 / tile, z0 / tile, x0 / tile, z0 / tile],
    );
  }

  /**
   * Axis-aligned box. Side UVs run along the wall (u) and up (v), top UVs are world xz; all
   * divided by `tile`. The bottom face is omitted (nothing sees under the city).
   */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    tile = 1,
    top = true,
  ): this {
    const t = tile;
    // +x, -x, +z, -z walls.
    this.quad(
      { x: x1, y: y0, z: z1 },
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: x1, y: y1, z: z1 },
      { x: 1, y: 0, z: 0 },
      [z1 / t, y0 / t, z0 / t, y0 / t, z0 / t, y1 / t, z1 / t, y1 / t],
    );
    this.quad(
      { x: x0, y: y0, z: z0 },
      { x: x0, y: y0, z: z1 },
      { x: x0, y: y1, z: z1 },
      { x: x0, y: y1, z: z0 },
      { x: -1, y: 0, z: 0 },
      [z0 / t, y0 / t, z1 / t, y0 / t, z1 / t, y1 / t, z0 / t, y1 / t],
    );
    this.quad(
      { x: x0, y: y0, z: z1 },
      { x: x1, y: y0, z: z1 },
      { x: x1, y: y1, z: z1 },
      { x: x0, y: y1, z: z1 },
      { x: 0, y: 0, z: 1 },
      [x0 / t, y0 / t, x1 / t, y0 / t, x1 / t, y1 / t, x0 / t, y1 / t],
    );
    this.quad(
      { x: x1, y: y0, z: z0 },
      { x: x0, y: y0, z: z0 },
      { x: x0, y: y1, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: 0, y: 0, z: -1 },
      [x1 / t, y0 / t, x0 / t, y0 / t, x0 / t, y1 / t, x1 / t, y1 / t],
    );
    if (top) this.flat(x0, z0, x1, z1, y1, t);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [name, a] of this.extra)
      g.setAttribute(name, new THREE.Float32BufferAttribute(a.data, a.size));
    g.setIndex(
      this.vertexCount > 65535
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1),
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
