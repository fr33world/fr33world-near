/**
 * Client physics (decision D-04): Rapier, built from the same city layout the server checks
 * movement against. Static colliders for the ground, sidewalk slabs, buildings, the freeways,
 * palms, lamp posts and the fountain, and walls along the coast; a kinematic capsule
 * controller for the player.
 *
 * Collision streaming: the city has ~8,000 static colliders, and stepping them all cost 2+ ms
 * per 60 Hz step (more on phones: the frame fell behind and the car jumped). Rapier charges
 * for disabled colliders too, so colliders are kept as descriptions grouped into the same
 * 400 m tiles as the graphics, and only tiles within ACTIVE_RADIUS of the player exist in the
 * world (focus() creates and removes them); the ground, coast walls and freeway decks stay.
 *
 * The ground: a flat floor under the city, and heightfields (shared terrain.ts samples) for the
 * hills, the mountains and the river channel, where the floor leaves a gap.
 */
import {
  barrierGaps,
  type CityLayout,
  carriageHalfWidth,
  FOUNTAIN_RADIUS,
  type Freeway,
  onDeck,
  PIER,
  LAKE,
  type Ramp,
  INTERIORS,
  type RampPoint,
  type Rect,
  RIVER,
  RIVER_FLOOR,
  TERRAIN_REGIONS,
  TERRAIN_STEP,
  terrainHeight,
  walkableOutline,
} from '@fr33world/city';
import RAPIER from '@dimforge/rapier3d-compat';
import { archFaces, archY } from './city/bridges.ts';
import { expandBySidewalks, segmentsBetweenJunctions, SLAB_Y } from './city/city.ts';
import { junctions, POLE_HEIGHT, SIGN_POST_HEIGHT } from './city/junctions.ts';
import { PROP_SIZE, propSpots, SHELTER, shelterSpots, treeSpots } from './city/placements.ts';
import { TILE } from './city/tiles.ts';
import { hillBoulders } from './city/hillscrub.ts';

export type Rapier = typeof RAPIER;

/** Fixed simulation step; frames accumulate time and run whole steps. */
export const PHYSICS_DT = 1 / 60;
/** Static colliders are enabled within this distance of the player (m). */
const ACTIVE_RADIUS = 300;

/** `r` minus `hole`: up to four rectangles. */
function cutOut(r: Rect, hole: Rect): Rect[] {
  if (hole.x0 >= r.x1 || hole.x1 <= r.x0 || hole.z0 >= r.z1 || hole.z1 <= r.z0) return [r];
  const out: Rect[] = [];
  if (hole.z0 > r.z0) out.push({ ...r, z1: hole.z0 });
  if (hole.z1 < r.z1) out.push({ ...r, z0: hole.z1 });
  const z0 = Math.max(r.z0, hole.z0);
  const z1 = Math.min(r.z1, hole.z1);
  if (hole.x0 > r.x0) out.push({ x0: r.x0, x1: hole.x0, z0, z1 });
  if (hole.x1 < r.x1) out.push({ x0: hole.x1, x1: r.x1, z0, z1 });
  return out;
}

export class Physics {
  readonly rapier: Rapier;
  readonly world: RAPIER.World;

  /** Collider descriptions by tile (tiles.ts), and the colliders of the tiles that exist now. */
  private readonly tiles = new Map<string, RAPIER.ColliderDesc[]>();
  private readonly active = new Map<string, RAPIER.Collider[]>();

  private constructor(rapier: Rapier) {
    this.rapier = rapier;
    this.world = new rapier.World({ x: 0, y: -16, z: 0 });
    this.world.timestep = PHYSICS_DT;
  }

  /** Builds the city's colliders, enabled around (focusX, focusZ) (default: the plaza). */
  static async create(city: CityLayout, focusX = 0, focusZ = 0): Promise<Physics> {
    await RAPIER.init();
    const p = new Physics(RAPIER);
    p.buildCity(city);
    p.focus(focusX, focusZ);
    return p;
  }

  /**
   * Enables the collider tiles within ACTIVE_RADIUS of (x, z) and disables the rest. Cheap when
   * nothing changes; call it every frame with where the player (or their car) is.
   */
  focus(x: number, z: number): void {
    const want = new Set<string>();
    const reach = Math.ceil(ACTIVE_RADIUS / TILE);
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    for (let i = tx - reach; i <= tx + reach; i += 1) {
      for (let j = tz - reach; j <= tz + reach; j += 1) {
        const dx = Math.max(0, Math.abs(x - (i + 0.5) * TILE) - TILE / 2);
        const dz = Math.max(0, Math.abs(z - (j + 0.5) * TILE) - TILE / 2);
        if (dx * dx + dz * dz <= ACTIVE_RADIUS * ACTIVE_RADIUS) want.add(`${i},${j}`);
      }
    }
    let changed = false;
    for (const [key, colliders] of this.active) {
      if (want.has(key)) continue;
      for (const c of colliders) this.world.removeCollider(c, false);
      this.active.delete(key);
      changed ||= colliders.length > 0;
    }
    for (const key of want) {
      if (this.active.has(key)) continue;
      const descs = this.tiles.get(key) ?? [];
      this.active.set(
        key,
        descs.map((d) => this.world.createCollider(d)),
      );
      changed ||= descs.length > 0;
    }
    // Scene queries (the player controller, car wheel rays) only see the change at the next
    // step. New colliders: until then a body there finds no ground, drops a step's worth and
    // stays sunk in it (the kinematic controller doesn't push out). Removed ones: queries
    // found nothing at all, not even the ground. A zero-length step re-indexes without moving
    // anything (Rapier treats dt = 0 as a no-op integration), but after many removals one
    // wasn't always enough (Rapier 0.21): step until a ray finds the ground here again (the
    // floor is everywhere, so it always should).
    if (changed) {
      const dt = this.world.timestep;
      this.world.timestep = 0;
      const down = new this.rapier.Ray({ x, y: 1000, z }, { x: 0, y: -1, z: 0 });
      for (let i = 0; i < 4; i += 1) {
        this.world.step();
        if (this.world.castRay(down, 2000, true)) break;
      }
      this.world.timestep = dt;
    }
  }

  /** Files a collider under its tile (by its centre), or creates it now and for good. */
  private place(desc: RAPIER.ColliderDesc, x: number, z: number, alwaysOn: boolean) {
    if (alwaysOn) {
      this.world.createCollider(desc);
      return;
    }
    const key = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
    let list = this.tiles.get(key);
    if (!list) this.tiles.set(key, (list = []));
    list.push(desc);
  }

  private fixedBox(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    alwaysOn = false,
  ) {
    const desc = this.rapier.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2)
      .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
      .setFriction(0.9);
    this.place(desc, (x0 + x1) / 2, (z0 + z1) / 2, alwaysOn);
  }

  /** A vertical wall from (ax, az) to (bx, bz), however it's oriented. */
  private fixedWall(ax: number, az: number, bx: number, bz: number, height: number, y0 = -1) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.01) return;
    const yaw = Math.atan2(bz - az, bx - ax);
    const desc = this.rapier.ColliderDesc.cuboid(len / 2, height / 2, 0.5)
      .setTranslation((ax + bx) / 2, y0 + height / 2, (az + bz) / 2)
      // Rotate the wall's x axis onto the segment (about y).
      .setRotation({ x: 0, y: Math.sin(-yaw / 2), z: 0, w: Math.cos(-yaw / 2) });
    this.world.createCollider(desc);
  }

  private fixedCylinder(x: number, y0: number, z: number, height: number, radius: number) {
    const desc = this.rapier.ColliderDesc.cylinder(height / 2, radius).setTranslation(
      x,
      y0 + height / 2,
      z,
    );
    this.place(desc, x, z, false);
  }

  private buildCity(city: CityLayout) {
    // The flat floor in 400 m squares, cut around the river channel sunk into it. (Two
    // lopsided slabs thousands of metres wide and 1 m thick broke the character controller's
    // ground contact: the player sank into the street.)
    const R = RIVER;
    for (let x = -3200; x < 3200; x += TILE) {
      for (let z = -3200; z < 3200; z += TILE) {
        for (const p of cutOut({ x0: x, z0: z, x1: x + TILE, z1: z + TILE }, R)) {
          this.fixedBox(p.x0, -2, p.z0, p.x1, 0, p.z1, true);
        }
      }
    }
    for (const region of TERRAIN_REGIONS) this.heightfield(region);
    for (const b of city.bridges) this.bridge(b);
    for (const block of city.blocks) {
      const r = expandBySidewalks(block, city.roads);
      this.fixedBox(r.x0, 0, r.z0, r.x1, SLAB_Y, r.z1);
    }
    for (const b of city.buildings) {
      const y = b.y ?? 0;
      this.fixedBox(
        b.x - b.w / 2,
        y - 2,
        b.z - b.d / 2,
        b.x + b.w / 2,
        y + SLAB_Y + b.h,
        b.z + b.d / 2,
      );
    }
    // Medians between junctions (cars cross at the junctions).
    for (const r of city.roads) {
      if (r.median === 0) continue;
      const half = carriageHalfWidth(r) - r.lanesPerDir * r.laneWidth;
      for (const [s0, s1] of segmentsBetweenJunctions(r, city.roads)) {
        if (r.axis === 'ns')
          this.fixedBox(r.center - half, 0, s0 + 1.5, r.center + half, 0.2, s1 - 1.5);
        else this.fixedBox(s0 + 1.5, 0, r.center - half, s1 - 1.5, 0.2, r.center + half);
      }
    }
    for (const fw of city.freeways) this.freeway(fw, city.ramps);
    for (const r of city.ramps) this.ramp(r, city.freeways);
    // Guard rails along the hill roads (the roads themselves are in the terrain).
    for (const rail of city.guardRails) {
      for (let i = 1; i < rail.points.length; i += 1) {
        this.segmentBox(
          rail.points[i - 1] as RampPoint,
          rail.points[i] as RampPoint,
          -0.1,
          0.1,
          0,
          0.8,
        );
      }
    }
    for (const palm of city.palms) this.fixedCylinder(palm.x, 0, palm.z, palm.height, 0.3);
    for (const t of treeSpots(city)) this.fixedCylinder(t.x, t.y, t.z, 2.6 * t.size, 0.24 * t.size);
    for (const l of city.lights) this.fixedCylinder(l.x, l.y ?? 0, l.z, 8.6, 0.16);
    // Street props: hydrants, bins, benches, planters, barriers (turned by quarter turns).
    for (const p of propSpots(city)) {
      const size = PROP_SIZE[p.kind];
      const across = Math.abs(Math.sin(p.yaw)) > 0.5;
      const [hx, hz] = across ? [size.hz, size.hx] : [size.hx, size.hz];
      this.fixedBox(p.x - hx, p.y, p.z - hz, p.x + hx, p.y + size.h, p.z + hz);
    }
    // Bus shelters: the glass back, the glass end and the ad panel's end are solid.
    const { w, d, h } = SHELTER;
    for (const sh of shelterSpots(city)) {
      const [c, sn] = [Math.round(Math.cos(sh.yaw)), Math.round(Math.sin(sh.yaw))];
      for (const [ax0, az0, ax1, az1] of [
        [-w / 2, -d / 2 - 0.05, w / 2, -d / 2 + 0.05],
        [-w / 2 - 0.05, -d / 2, -w / 2 + 0.05, d / 2 - 0.25],
        [w / 2 - 0.15, -d / 2 + 0.1, w / 2 + 0.05, d / 2 - 0.25],
      ] as const) {
        // The local box turned by the shelter's quarter turn (x' = x cos + z sin, z' = z cos - x sin).
        const xs = [ax0 * c + az0 * sn, ax1 * c + az1 * sn];
        const zs = [az0 * c - ax0 * sn, az1 * c - ax1 * sn];
        this.fixedBox(
          sh.x + Math.min(...xs),
          SLAB_Y,
          sh.z + Math.min(...zs),
          sh.x + Math.max(...xs),
          SLAB_Y + h,
          sh.z + Math.max(...zs),
        );
      }
    }
    // Traffic signal poles and street-name sign posts.
    for (const j of junctions(city)) {
      for (const s of j.signals) this.fixedCylinder(s.x, 0, s.z, POLE_HEIGHT, 0.15);
      if (j.signals.length === 0) this.fixedCylinder(j.sign.x, 0, j.sign.z, SIGN_POST_HEIGHT, 0.08);
    }
    const cx = (city.plaza.x0 + city.plaza.x1) / 2;
    const cz = (city.plaza.z0 + city.plaza.z1) / 2;
    this.fixedCylinder(cx, 0, cz, SLAB_Y + 0.75, FOUNTAIN_RADIUS);
    for (const s of city.solids) this.fixedBox(s.x0, s.y0, s.z0, s.x1, s.y1, s.z1);
    // The rooms' floors (interiors.ts): the walls are among the solids.
    for (const { rect: r } of Object.values(INTERIORS))
      this.fixedBox(r.x0 - 1, -1, r.z0 - 1, r.x1 + 1, 0, r.z1 + 1);
    // The hills' big boulders (hillscrub.ts): solid, streamed like the rest.
    for (const b of hillBoulders()) this.fixedCylinder(b.x, b.y - 0.5, b.z, b.r * 1.3 + 0.5, b.r);
    // The pier's deck, at sidewalk height.
    for (const p of PIER) this.fixedBox(p.x0, 0, p.z0, p.x1, SLAB_Y, p.z1);
    // The sea: walls along the coast, round the pier and the harbour (the server refuses water
    // too).
    const land = walkableOutline();
    for (let i = 0; i < land.length; i += 1) {
      const [ax, az] = land[i] as [number, number];
      const [bx, bz] = land[(i + 1) % land.length] as [number, number];
      this.fixedWall(ax, az, bx, bz, 20);
    }
    // And round the lake, a metre in from its edge (half a wall's thickness further in).
    const ring = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return [LAKE.x + Math.cos(a) * (LAKE.rx - 1.5), LAKE.z + Math.sin(a) * (LAKE.rz - 1.5)];
    });
    ring.forEach(([ax, az], i) => {
      const [bx, bz] = ring[(i + 1) % ring.length] as [number, number];
      this.fixedWall(ax as number, az as number, bx, bz, 20, LAKE.level - 8);
    });
  }

  /**
   * A heightfield over `r` from the terrain samples (TERRAIN_STEP apart). Rapier's matrix has a
   * row per z sample and a column per x sample, stored column by column, centred on the
   * collider's position.
   */
  private heightfield(r: Rect) {
    const cols = Math.round((r.x1 - r.x0) / TERRAIN_STEP);
    const rows = Math.round((r.z1 - r.z0) / TERRAIN_STEP);
    const heights = new Float32Array((rows + 1) * (cols + 1));
    for (let j = 0; j <= cols; j += 1) {
      for (let i = 0; i <= rows; i += 1) {
        heights[j * (rows + 1) + i] = terrainHeight(
          r.x0 + j * TERRAIN_STEP,
          r.z0 + i * TERRAIN_STEP,
        );
      }
    }
    const desc = this.rapier.ColliderDesc.heightfield(rows, cols, heights, {
      x: r.x1 - r.x0,
      y: 1,
      z: r.z1 - r.z0,
    })
      .setTranslation((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2)
      .setFriction(0.9);
    this.world.createCollider(desc);
  }

  /**
   * A bridge over the river: the deck, raised sidewalks and parapets along both sides, and its
   * arches and their columns (bridges.ts) for whoever drives along the channel under it.
   */
  private bridge(b: CityLayout['bridges'][number]) {
    this.fixedBox(b.x0, -1.4, b.z - b.half - 1.4, b.x1, 0, b.z + b.half + 1.4, true);
    for (const side of [-1, 1]) {
      const [a, c] = [b.z + side * b.carriage, b.z + side * b.half];
      this.fixedBox(b.x0, 0, Math.min(a, c), b.x1, SLAB_Y, Math.max(a, c), true);
      const [p0, p1] = [b.z + side * b.half, b.z + side * (b.half + 0.4)];
      this.fixedBox(b.x0, 0, Math.min(p0, p1), b.x1, 1.2, Math.max(p0, p1), true);
    }
    for (const z of archFaces(b)) {
      for (let x = RIVER_FLOOR.x0; x < RIVER_FLOOR.x1; x += 2) {
        const y = archY(x + 1);
        this.fixedBox(x, y - 0.6, z - 0.55, x + 2, Math.min(y + 0.6, -1.4), z + 0.55);
      }
      for (let x = RIVER_FLOOR.x0 + 5.5; x < RIVER_FLOOR.x1 - 3; x += 5.5) {
        this.fixedBox(x - 0.3, archY(x), z - 0.4, x + 0.3, -1.4, z + 0.4);
      }
    }
  }

  /**
   * A box along a ramp segment, tilted with it: `across` offsets either side of the centreline,
   * `below` and `above` its surface.
   */
  private segmentBox(
    a: RampPoint,
    b: RampPoint,
    across0: number,
    across1: number,
    below: number,
    above: number,
  ) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const flat = Math.hypot(dx, dz);
    if (flat < 0.01) return;
    const len = Math.hypot(flat, dy);
    const yaw = Math.atan2(-dz, dx);
    const pitch = Math.atan2(dy, flat);
    const [sy, cy, sp, cp] = [
      Math.sin(yaw / 2),
      Math.cos(yaw / 2),
      Math.sin(pitch / 2),
      Math.cos(pitch / 2),
    ];
    // The box's own axes in the world: up (tilted with the slope) and across (level).
    const up = {
      x: -Math.sin(pitch) * Math.cos(yaw),
      y: Math.cos(pitch),
      z: Math.sin(pitch) * Math.sin(yaw),
    };
    const side = { x: -dz / flat, z: dx / flat };
    const c = (across0 + across1) / 2;
    const v = (above - below) / 2;
    const cx = (a.x + b.x) / 2 + side.x * c + up.x * v;
    const cyy = (a.y + b.y) / 2 + up.y * v;
    const cz = (a.z + b.z) / 2 + side.z * c + up.z * v;
    const desc = this.rapier.ColliderDesc.cuboid(
      len / 2 + 0.25,
      (above + below) / 2,
      (across1 - across0) / 2,
    )
      .setTranslation(cx, cyy, cz)
      .setRotation({ x: sy * sp, y: sy * cp, z: cy * sp, w: cy * cp })
      .setFriction(0.9);
    this.place(desc, cx, cz, false);
  }

  /** A ramp: its slab, barriers along both sides where it isn't over a deck, its columns. */
  private ramp(r: Ramp, freeways: Freeway[]) {
    const half = r.width / 2;
    for (let i = 1; i < r.points.length; i += 1) {
      const a = r.points[i - 1] as RampPoint;
      const b = r.points[i] as RampPoint;
      this.segmentBox(a, b, -half, half, r.depth, 0);
      if (r.kind === 'descent') this.segmentBox(a, b, -0.3, 0.3, 0, 0.85);
      for (const side of [-1, 1]) {
        // Where the barrier's middle is: skip it over a deck (the ramp joins the deck there).
        const nx = -(b.z - a.z);
        const nz = b.x - a.x;
        const n = Math.hypot(nx, nz) || 1;
        const mx = (a.x + b.x) / 2 + (nx / n) * side * (half - 0.25);
        const mz = (a.z + b.z) / 2 + (nz / n) * side * (half - 0.25);
        if (freeways.some((f) => onDeck(f, mx, mz, 0.5))) continue;
        const [c0, c1] = side < 0 ? [-half, -half + 0.5] : [half - 0.5, half];
        this.segmentBox(a, b, c0, c1, 0, 0.9);
      }
    }
    for (const p of r.pillars) {
      const foot = Math.min(0, terrainHeight(p.x, p.z));
      this.fixedBox(p.x - p.w / 2, foot, p.z - p.d / 2, p.x + p.w / 2, p.top, p.z + p.d / 2);
    }
  }

  private freeway(fw: Freeway, ramps: Ramp[]) {
    const half = fw.width / 2;
    const deck = (
      a0: number,
      c0: number,
      a1: number,
      c1: number,
      y0: number,
      y1: number,
      alwaysOn: boolean,
    ) =>
      fw.axis === 'ew'
        ? this.fixedBox(a0, y0, c0, a1, y1, c1, alwaysOn)
        : this.fixedBox(c0, y0, a0, c1, y1, a1, alwaysOn);
    deck(fw.from, fw.center - half, fw.to, fw.center + half, fw.deckY - 1.4, fw.deckY, true);
    // Barriers along both edges (open where a ramp joins) and down the middle, in pieces so
    // they stream with the tiles.
    const gaps = barrierGaps(fw, ramps);
    for (const [side, c] of [
      [-1, fw.center - half + 0.3],
      [1, fw.center + half - 0.3],
      [0, fw.center],
    ] as const) {
      const open = gaps.filter(([s]) => s === side).sort((p, q) => p[1] - q[1]);
      let at = fw.from;
      for (const [, g0, g1] of [...open, [side, fw.to, fw.to] as const]) {
        for (let a = at; a < g0; a += 200) {
          const b = Math.min(g0, a + 200);
          deck(a, c - 0.3, b, c + 0.3, fw.deckY, fw.deckY + 0.85, false);
        }
        at = Math.max(at, g1);
      }
    }
    for (const pl of fw.pillars) {
      this.fixedBox(
        pl.x - pl.w / 2,
        Math.min(0, terrainHeight(pl.x, pl.z)),
        pl.z - pl.d / 2,
        pl.x + pl.w / 2,
        fw.deckY,
        pl.z + pl.d / 2,
      );
    }
  }

  step(): void {
    this.world.step();
  }

  /**
   * Distance along a ray to the first static obstacle, or `max` (used to keep the camera out of
   * walls). Bodies listed in `exclude` are ignored.
   */
  rayDistance(
    from: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    max: number,
    exclude?: RAPIER.RigidBody,
  ): number {
    const ray = new this.rapier.Ray(from, dir);
    const hit = this.world.castRay(ray, max, true, undefined, undefined, undefined, exclude);
    return hit ? hit.timeOfImpact : max;
  }
}
