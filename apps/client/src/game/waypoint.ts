/**
 * Waypoints that follow roads (Phase 6): one destination at a time (a spot marked on the map,
 * a job's next stop, the tutorial's next place), routed along the streets and hill roads
 * (city RoadGraph), or for someone on foot the short way when that's much shorter (Footpaths).
 * The way shows as a ribbon of moving chevrons on the road ahead and a beam of light over the
 * destination, and on the minimap and the map as a line. It re-routes when the player leaves
 * the route, and a spot marked on the map clears itself on arrival.
 */
import {
  type CityLayout,
  Footpaths,
  RoadGraph,
  type Route,
  type Solid2D,
  walkHeight,
} from '@fr33world/city';
import * as THREE from 'three';
import { hillBoulders } from './city/hillscrub.ts';
import { junctions } from './city/junctions.ts';
import { PROP_SIZE, propSpots, SHELTER, shelterSpots, treeSpots } from './city/placements.ts';

/** How much of the route ahead the ribbon shows (m), and how close counts as arrived. */
const AHEAD = 420;
const ARRIVED = 7;
/** Off the route by this much (m), it's planned again: less off the road, where walls are near. */
const STRAY = 28;
const STRAY_OFF_ROAD = 10;

export interface Target {
  x: number;
  z: number;
  label: string;
  /** Who set it: a map mark clears on arrival; jobs and the tutorial clear their own. */
  by: 'map' | 'job' | 'tutorial';
}

/** What physics.ts stands in a walker's way that the city's layout doesn't know about. */
export function furniture(city: CityLayout): Solid2D[] {
  const box = (x: number, z: number, hx: number, hz: number): Solid2D => ({
    x0: x - hx,
    x1: x + hx,
    z0: z - hz,
    z1: z + hz,
  });
  const across = (yaw: number) => Math.abs(Math.sin(yaw)) > 0.5;
  return [
    ...propSpots(city).map((p) => {
      const { hx, hz } = PROP_SIZE[p.kind];
      return across(p.yaw) ? box(p.x, p.z, hz, hx) : box(p.x, p.z, hx, hz);
    }),
    ...shelterSpots(city).map((s) => {
      const [hx, hz] = [SHELTER.w / 2, SHELTER.d / 2];
      return across(s.yaw) ? box(s.x, s.z, hz, hx) : box(s.x, s.z, hx, hz);
    }),
    ...hillBoulders().map((b) => box(b.x, b.z, b.r, b.r)),
    ...city.palms.map((p) => box(p.x, p.z, 0.3, 0.3)),
    ...city.lights.map((l) => box(l.x, l.z, 0.16, 0.16)),
    ...treeSpots(city).map((t) => box(t.x, t.z, 0.24 * t.size, 0.24 * t.size)),
    ...junctions(city).flatMap((j) => [
      ...j.signals.map((s) => box(s.x, s.z, 0.15, 0.15)),
      box(j.sign.x, j.sign.z, 0.08, 0.08),
    ]),
  ];
}

function chevrons(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 11;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  // Pointing along +u (the way to go).
  g.moveTo(18, 10);
  g.lineTo(44, 32);
  g.lineTo(18, 54);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(255,255,255,0.9)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

export class Waypoints {
  target: Target | null = null;
  route: Route | null = null;
  /** Along the roads from where the player is now (m). */
  remaining = 0;
  private graph: RoadGraph | null = null;
  private paths: Footpaths | null = null;
  private readonly layout: CityLayout;
  private readonly ribbon: THREE.Mesh;
  private readonly ribbonTexture = chevrons();
  private readonly beam: THREE.Mesh;
  private plannedAt = 0;
  private builtFrom = -1;
  private onFoot = true;

  constructor(scene: THREE.Scene, layout: CityLayout) {
    this.layout = layout;
    this.ribbon = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        map: this.ribbonTexture,
        color: 0x7def06,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 2;
    this.ribbon.visible = false;
    const beam = new THREE.CylinderGeometry(1.6, 1.6, 90, 24, 1, true);
    beam.translate(0, 45, 0);
    this.beam = new THREE.Mesh(
      beam,
      new THREE.MeshBasicMaterial({
        map: beamTexture(),
        color: 0x7def06,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.beam.visible = false;
    scene.add(this.ribbon, this.beam);
  }

  /** The road graph, built the first time a route is wanted (a few milliseconds). */
  private roads(): RoadGraph {
    this.graph ??= RoadGraph.fromCity(this.layout);
    return this.graph;
  }

  /** The ways on foot, built with the road graph. */
  private footpaths(): Footpaths {
    this.paths ??= new Footpaths(this.layout, this.roads(), furniture(this.layout));
    return this.paths;
  }

  /** The tutorial says where to go every frame: only a new place starts a new route. */
  set(target: Target): void {
    const t = this.target;
    if (t?.x === target.x && t.z === target.z && t.by === target.by && t.label === target.label)
      return;
    this.target = target;
    this.route = null;
    this.plannedAt = 0;
  }

  clear(by?: Target['by']): void {
    if (by && this.target?.by !== by) return;
    this.target = null;
    this.route = null;
    this.ribbon.visible = false;
    this.beam.visible = false;
  }

  /** Once a frame with where the player is. Returns true on arriving. */
  update(x: number, z: number, now: number, dt: number, onFoot: boolean): boolean {
    const t = this.target;
    if (!t) return false;
    const straight = Math.hypot(t.x - x, t.z - z);
    if (straight < ARRIVED) {
      if (t.by === 'map') this.clear();
      return true;
    }
    // Getting in or out of a car changes what the way is.
    if (onFoot !== this.onFoot) {
      this.onFoot = onFoot;
      this.route = null;
    }
    // Plan again when there's no route, the player has strayed from it, or every few seconds.
    const off = this.route ? this.offRoute(x, z) : Infinity;
    const offRoad = this.route?.offRoad === true;
    if (off > (offRoad ? STRAY_OFF_ROAD : STRAY) || (!offRoad && now - this.plannedAt > 4000)) {
      this.plannedAt = now;
      const way = onFoot ? this.footpaths() : this.roads();
      this.route = way.route(x, z, t.x, t.z) ?? {
        points: [
          [x, z],
          [t.x, t.z],
        ],
        length: straight,
      };
      this.builtFrom = -1;
    }
    const route = this.route;
    if (!route) return false;
    // From the route point nearest the player, onwards.
    const from = this.nearestIndex(x, z);
    this.remaining = this.lengthFrom(from, x, z);
    if (from !== this.builtFrom) {
      this.builtFrom = from;
      this.buildRibbon(from, x, z);
    }
    this.ribbonTexture.offset.x -= dt * 1.2;
    this.beam.position.set(t.x, walkHeight(this.layout, t.x, t.z), t.z);
    this.beam.visible = true;
    return false;
  }

  private nearestIndex(x: number, z: number): number {
    const pts = this.route?.points ?? [];
    let best = 0;
    let d = Infinity;
    pts.forEach(([px, pz], i) => {
      const e = Math.hypot(px - x, pz - z);
      if (e < d) {
        d = e;
        best = i;
      }
    });
    return best;
  }

  private offRoute(x: number, z: number): number {
    const pts = this.route?.points ?? [];
    let d = Infinity;
    for (let i = 1; i < pts.length; i += 1) {
      const [ax, az] = pts[i - 1] as [number, number];
      const [bx, bz] = pts[i] as [number, number];
      const vx = bx - ax;
      const vz = bz - az;
      const len2 = vx * vx + vz * vz || 1;
      const k = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2));
      d = Math.min(d, Math.hypot(ax + vx * k - x, az + vz * k - z));
    }
    return d;
  }

  private lengthFrom(i: number, x: number, z: number): number {
    const pts = this.route?.points ?? [];
    const first = pts[i];
    if (!first) return 0;
    let total = Math.hypot(first[0] - x, first[1] - z);
    for (let k = i + 1; k < pts.length; k += 1) {
      const [ax, az] = pts[k - 1] as [number, number];
      const [bx, bz] = pts[k] as [number, number];
      total += Math.hypot(bx - ax, bz - az);
    }
    return total;
  }

  /** A strip 1.4 m wide along the next AHEAD metres, chevrons every 2.5 m. */
  private buildRibbon(from: number, x: number, z: number) {
    const route = this.route?.points ?? [];
    // The destination stays in it, however near the player is to that last point.
    const next = Math.min(from + 1, route.length - 1);
    const pts: [number, number][] = [[x, z], ...route.slice(next)];
    // Every couple of metres, so it follows the ground over hills.
    const dense: [number, number][] = [];
    let walked = 0;
    for (let i = 1; i < pts.length && walked < AHEAD; i += 1) {
      const [ax, az] = pts[i - 1] as [number, number];
      const [bx, bz] = pts[i] as [number, number];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / 2));
      for (let k = 0; k < n; k += 1)
        dense.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
      walked += len;
    }
    dense.push(pts.at(-1) as [number, number]);
    if (dense.length < 2) {
      this.ribbon.visible = false;
      return;
    }
    const pos: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    // Counted back from the destination, so the chevrons stay put when this is rebuilt.
    let u = -this.lengthFrom(next, x, z) / 2.5;
    dense.forEach(([px, pz], i) => {
      const [nx, nz] = dense[Math.min(i + 1, dense.length - 1)] as [number, number];
      const [qx, qz] = dense[Math.max(i - 1, 0)] as [number, number];
      let dx = nx - qx;
      let dz = nz - qz;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      if (i > 0) {
        const [lx, lz] = dense[i - 1] as [number, number];
        u += Math.hypot(px - lx, pz - lz) / 2.5;
      }
      const y = walkHeight(this.layout, px, pz) + 0.22;
      // Sideways: (−dz, dx).
      pos.push(px - dz * 0.7, y, pz + dx * 0.7, px + dz * 0.7, y, pz - dx * 0.7);
      uv.push(u, 0, u, 1);
      if (i > 0) {
        const a = (i - 1) * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const g = this.ribbon.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    this.ribbon.visible = true;
  }
}
