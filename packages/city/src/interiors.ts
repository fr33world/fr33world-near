/**
 * Inside the Police Station, the Hospital and the gang houses (owner, 2026-10-31), as data shared
 * by the server and the client. Each is a real room far out past the coast, reached only through
 * its entrance marker (the server moves the body, nothing walks there): its walls and furniture
 * are ordinary `solids`, so physics and the server's wall test need nothing new, and the people
 * in a room are near only each other. The client draws a room as one merged mesh with its light
 * painted in, and hides the city while inside.
 */
import type { Solid } from './landmarks.ts';
import type { Rect } from './layout.ts';

export type ServiceId = 'police' | 'hospital' | 'vipers' | 'kings';
export const SERVICE_IDS: readonly ServiceId[] = ['police', 'hospital', 'vipers', 'kings'];

/** The rooms' surfaces (client public/assets/textures/room_*.webp). */
export type RoomTexture =
  'plaster' | 'tile' | 'wood_floor' | 'carpet' | 'ceiling' | 'wood' | 'fabric';

/** A box in a room, local metres from its south-west corner. */
export interface RoomBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
  colour: number;
  /** Bodies can't pass through it. */
  solid?: boolean;
  /** Lit from within: drawn at full brightness (lamps, screens). */
  glow?: boolean;
  tex?: RoomTexture;
  /** Only stops bodies: a chair's footprint, under the legs and seat that are drawn. */
  hidden?: boolean;
}

/** Words on a wall, facing `yaw` (0 = +z), in world coordinates. */
export interface RoomLabel {
  text: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Width and height of the plate (m). */
  w: number;
  h: number;
  colour: string;
  back: string;
}

export interface RoomPoint {
  kind: 'exit' | 'locker' | 'counter' | 'computer';
  x: number;
  z: number;
  yaw: number;
  radius: number;
  name: string;
}

/** A hospital bed: where the head of the patient lies and the way they lie. */
export interface Bed {
  x: number;
  z: number;
  yaw: number;
}

/** Somewhere to sit, in world coordinates, facing `yaw`. */
export interface Seat {
  x: number;
  z: number;
  yaw: number;
}

/** A furniture model (client public/assets/props) on the floor, in world coordinates. */
export interface RoomProp {
  kind: 'plant' | 'sofa' | 'desk';
  x: number;
  z: number;
  yaw: number;
  scale: number;
}

export interface Interior {
  id: ServiceId;
  name: string;
  rect: Rect;
  height: number;
  boxes: RoomBox[];
  labels: RoomLabel[];
  points: RoomPoint[];
  beds: Bed[];
  seats: Seat[];
  props: RoomProp[];
  /** Where you arrive, just inside the door. */
  spawn: { x: number; z: number; yaw: number };
  /** No shooting in here. */
  safe: boolean;
  /** Only this faction's members may go in. */
  members: boolean;
  accent: number;
}

/**
 * Going through a door (owner, 2026-10-31: it threw players back out, and missed them walking up
 * to it). Outside, the ring reaches the wall; you land past it, so stepping back in just works.
 * Inside, the way out is a small ring hard against the door, and you arrive well clear of it.
 */
export const DOOR = {
  /** The entrance's ring: its centre from the building's wall, and its radius (m). */
  entranceM: 1.4,
  entranceRadius: 2.1,
  /** Where you land outside, from the ring's centre. */
  stepOut: 2.6,
  exitZ: 0.9,
  exitRadius: 1.1,
  /** Where you arrive inside, from the wall with the door. */
  spawnZ: 4.4,
  /** A ring works again once you're this far past its edge... */
  rearm: 0.3,
  /** ...and this long (ms) after the last door, so backing through one doesn't ping-pong. */
  restMs: 1_000,
} as const;

/** Past every coast. Rooms stand in a row, apart enough never to see each other. */
const ORIGIN_X = 4000;
const ORIGIN_Z = 4000;
const SPACING = 120;
/** How high a patient lies on a bed (m). */
export const BED_Y = 0.62;
/** The lying pose lies at an angle to its own facing: this turn (radians) squares it up. */
export const BED_TURN = -0.55;
/** Top of a chair's seat (m): the sitting clip's hips rest just above it. */
export const SEAT_Y = 0.41;
/** Where you stand up to, in front of a seat (m). */
export const SEAT_STEP_M = 0.62;
/** How near a seat you can sit on it (m). */
export const SEAT_REACH_M = 1.5;

const WALL = 0.3;
const WOOD = 0xb08a64;
const STEEL = 0x8b9198;
const DARK = 0x24282e;
const SCREEN = 0x53b7ff;
const SHEET = 0xf1f4f6;

type Faces = 'north' | 'south' | 'east' | 'west';
const FACING: Record<Faces, { dx: number; dz: number; yaw: number }> = {
  north: { dx: 0, dz: 1, yaw: 0 },
  south: { dx: 0, dz: -1, yaw: Math.PI },
  east: { dx: 1, dz: 0, yaw: Math.PI / 2 },
  west: { dx: -1, dz: 0, yaw: -Math.PI / 2 },
};

class Room {
  readonly boxes: RoomBox[] = [];
  readonly labels: RoomLabel[] = [];
  readonly points: RoomPoint[] = [];
  readonly beds: Bed[] = [];
  readonly seats: Seat[] = [];
  readonly props: RoomProp[] = [];

  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;

  constructor(x: number, z: number, w: number, d: number, h: number) {
    this.x = x;
    this.z = z;
    this.w = w;
    this.d = d;
    this.h = h;
  }

  /** A box from (x0, z0) to (x1, z1), y0 to y1 up. */
  box(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y0: number,
    y1: number,
    colour: number,
    tex?: RoomTexture,
  ) {
    this.boxes.push({ x0, z0, x1, z1, y0, y1, colour, ...(tex && { tex }) });
    return this;
  }

  /** The same, solid. */
  block(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y0: number,
    y1: number,
    colour: number,
    tex?: RoomTexture,
  ) {
    this.boxes.push({ x0, z0, x1, z1, y0, y1, colour, solid: true, ...(tex && { tex }) });
    return this;
  }

  /** Stops bodies, and isn't drawn. */
  stop(x0: number, z0: number, x1: number, z1: number, y1: number) {
    this.boxes.push({ x0, z0, x1, z1, y0: 0, y1, colour: 0, solid: true, hidden: true });
    return this;
  }

  glow(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, colour: number) {
    this.boxes.push({ x0, z0, x1, z1, y0, y1, colour, glow: true });
    return this;
  }

  /** The shell: floor, panelled ceiling, plaster walls, skirting, and rows of ceiling lights. */
  shell(floor: number, floorTex: RoomTexture, wall: number, skirt: number, lights: number) {
    const { w, d, h } = this;
    this.box(0, 0, w, d, -0.2, 0, floor, floorTex);
    this.box(0, 0, w, d, h, h + 0.2, 0xf4f4f2, 'ceiling');
    this.block(-WALL, -WALL, w + WALL, 0, 0, h, wall, 'plaster');
    this.block(-WALL, d, w + WALL, d + WALL, 0, h, wall, 'plaster');
    this.block(-WALL, 0, 0, d, 0, h, wall, 'plaster');
    this.block(w, 0, w + WALL, d, 0, h, wall, 'plaster');
    this.box(0, 0, w, 0.02, 0, 0.14, skirt);
    this.box(0, d - 0.02, w, d, 0, 0.14, skirt);
    this.box(0, 0, 0.02, d, 0, 0.14, skirt);
    this.box(w - 0.02, 0, w, d, 0, 0.14, skirt);
    for (let i = 0; i < lights; i += 1) {
      const cx = (w * (i + 0.5)) / lights;
      for (const cz of [d * 0.28, d * 0.72]) this.lamp(cx, cz);
    }
    return this;
  }

  /** One ceiling light. */
  lamp(cx: number, cz: number) {
    const { h } = this;
    this.box(cx - 1.26, cz - 0.36, cx + 1.26, cz + 0.36, h - 0.03, h, 0xd8dade);
    this.glow(cx - 1.2, cz - 0.3, cx + 1.2, cz + 0.3, h - 0.05, h - 0.03, 0xfff6e4);
    return this;
  }

  /** An inner east–west wall at `z`, with a doorway from `gap0` to `gap1`. */
  partition(z: number, gap0: number, gap1: number, colour: number) {
    const { w, h } = this;
    this.block(0, z - 0.1, gap0, z + 0.1, 0, h, colour, 'plaster');
    this.block(gap1, z - 0.1, w, z + 0.1, 0, h, colour, 'plaster');
    // Not solid: the server's wall test goes by footprint, so this would shut the doorway.
    this.box(gap0, z - 0.1, gap1, z + 0.1, 2.4, h, colour, 'plaster');
    this.box(gap0 - 0.06, z - 0.14, gap0, z + 0.14, 0, 2.46, DARK);
    this.box(gap1, z - 0.14, gap1 + 0.06, z + 0.14, 0, 2.46, DARK);
    this.box(gap0 - 0.06, z - 0.14, gap1 + 0.06, z + 0.14, 2.4, 2.46, DARK);
    return this;
  }

  /** An inner north–south wall at `x`, `z0` to `z1`, with a doorway from `gap0` to `gap1`. */
  crossWall(x: number, z0: number, z1: number, gap0: number, gap1: number, colour: number) {
    const { h } = this;
    this.block(x, z0, x + 0.2, gap0, 0, h, colour, 'plaster');
    this.block(x, gap1, x + 0.2, z1, 0, h, colour, 'plaster');
    this.box(x, gap0, x + 0.2, gap1, 2.4, h, colour, 'plaster');
    this.box(x - 0.04, gap0 - 0.06, x + 0.24, gap0, 0, 2.46, DARK);
    this.box(x - 0.04, gap1, x + 0.24, gap1 + 0.06, 0, 2.46, DARK);
    this.box(x - 0.04, gap0 - 0.06, x + 0.24, gap1 + 0.06, 2.4, 2.46, DARK);
    return this;
  }

  /** The way out, on the south wall at x: double glass doors, a green sign over them. */
  door(x: number) {
    this.box(x - 1.12, 0, x + 1.12, 0.05, 0, 2.5, DARK);
    for (const [a, b] of [
      [x - 1.03, x - 0.03],
      [x + 0.03, x + 1.03],
    ] as const) {
      this.box(a, 0.05, b, 0.07, 0.06, 2.42, 0x39424c);
      this.glow(a + 0.1, 0.07, b - 0.1, 0.08, 0.45, 2.3, 0x8fb4c9);
      this.box(a + 0.12, 0.08, b - 0.12, 0.13, 1.02, 1.08, STEEL);
    }
    this.glow(x - 0.42, 0.05, x + 0.42, 0.08, 2.56, 2.8, 0x3fdc6e);
    this.point('exit', x, DOOR.exitZ, 0, 'Way out', DOOR.exitRadius);
    return this;
  }

  point(kind: RoomPoint['kind'], x: number, z: number, yaw: number, name: string, radius = 1.8) {
    this.points.push({ kind, x: this.x + x, z: this.z + z, yaw, radius, name });
    return this;
  }

  /** A plate on a wall. `side`: which wall it faces out from. */
  label(
    text: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    w: number,
    h: number,
    colour = '#ffffff',
    back = '#14202e',
  ) {
    this.labels.push({ text, x: this.x + x, y, z: this.z + z, yaw, w, h, colour, back });
    return this;
  }

  prop(kind: RoomProp['kind'], x: number, z: number, yaw = 0, scale = 1) {
    this.props.push({ kind, x: this.x + x, z: this.z + z, yaw, scale });
    return this;
  }

  /** One chair you can sit on. */
  chair(x: number, z: number, faces: Faces, colour: number, tex?: RoomTexture) {
    const { dx, dz, yaw } = FACING[faces];
    const half = 0.26;
    // Across the chair and towards its front, as a box either way round.
    const part = (s0: number, s1: number, f0: number, f1: number, y0: number, y1: number) => {
      const xs = dx === 0 ? [x + s0, x + s1] : [x + f0 * dx, x + f1 * dx];
      const zs = dx === 0 ? [z + f0 * dz, z + f1 * dz] : [z + s0, z + s1];
      return [
        Math.min(xs[0] as number, xs[1] as number),
        Math.min(zs[0] as number, zs[1] as number),
        Math.max(xs[0] as number, xs[1] as number),
        Math.max(zs[0] as number, zs[1] as number),
        y0,
        y1,
      ] as const;
    };
    const [x0, z0, x1, z1] = part(-half, half, -half, half, 0, 0.42);
    this.stop(x0, z0, x1, z1, 0.42);
    for (const s of [-0.22, 0.2])
      for (const f of [-0.22, 0.2])
        this.box(...part(s, s + 0.03, f, f + 0.03, 0, SEAT_Y - 0.06), STEEL);
    this.box(...part(-half, half, -half, half, SEAT_Y - 0.08, SEAT_Y), colour, tex);
    this.box(...part(-half, half, -half, -half + 0.05, SEAT_Y, 0.9), colour, tex);
    this.seats.push({ x: this.x + x, z: this.z + z, yaw });
    return this;
  }

  /** A row of chairs along x (facing north or south) or z (east or west). */
  chairs(from: number, to: number, at: number, faces: Faces, colour: number, tex?: RoomTexture) {
    for (let a = from; a <= to; a += 0.72)
      if (faces === 'north' || faces === 'south') this.chair(a, at, faces, colour, tex);
      else this.chair(at, a, faces, colour, tex);
    return this;
  }

  /** A desk with a monitor, a keyboard and a chair; the screen faces the chair, to the south. */
  desk(x: number, z: number) {
    this.prop('desk', x, z, Math.PI);
    this.stop(x - 0.75, z - 0.4, x + 0.75, z + 0.4, 0.76);
    this.box(x - 0.04, z + 0.06, x + 0.04, z + 0.12, 0.76, 0.92, DARK);
    this.box(x - 0.14, z + 0.02, x + 0.14, z + 0.16, 0.76, 0.78, DARK);
    this.box(x - 0.3, z + 0.05, x + 0.3, z + 0.1, 0.86, 1.2, DARK);
    this.glow(x - 0.27, z + 0.03, x + 0.27, z + 0.05, 0.89, 1.17, SCREEN);
    this.box(x - 0.2, z - 0.24, x + 0.2, z - 0.1, 0.76, 0.785, 0x33373d);
    this.chair(x, z - 0.95, 'north', 0x4a5364, 'fabric');
    return this;
  }

  /** A row of lockers along the east wall, z0 to z1. */
  lockers(x: number, z0: number, z1: number, colour: number) {
    const n = Math.round((z1 - z0) / 0.6);
    for (let i = 0; i < n; i += 1) {
      const a = z0 + ((z1 - z0) * i) / n;
      const b = a + (z1 - z0) / n - 0.04;
      this.block(x, a, x + 0.55, b, 0, 2, colour);
      this.box(x - 0.02, a + 0.22, x, a + 0.3, 1.0, 1.25, STEEL);
      for (const y of [1.7, 1.76, 1.82])
        this.box(x - 0.01, a + 0.12, x, b - 0.12, y, y + 0.02, DARK);
    }
    return this;
  }

  bed(x: number, z: number, yaw: number) {
    const along = Math.abs(Math.sin(yaw)) > 0.5;
    const [hw, hd] = along ? [1, 0.48] : [0.48, 1];
    // The frame on its legs, the mattress, a rail each side.
    this.stop(x - hw, z - hd, x + hw, z + hd, 0.6);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        this.box(
          x + sx * (hw - 0.05) - 0.03,
          z + sz * (hd - 0.05) - 0.03,
          x + sx * (hw - 0.05) + 0.03,
          z + sz * (hd - 0.05) + 0.03,
          0,
          0.4,
          STEEL,
        );
    this.box(x - hw, z - hd, x + hw, z + hd, 0.34, 0.42, STEEL);
    this.box(x - hw + 0.03, z - hd + 0.03, x + hw - 0.03, z + hd - 0.03, 0.42, 0.56, SHEET);
    // A blanket over the foot, and a pillow at the head.
    const fx = along ? Math.sin(yaw) : 0;
    const fz = along ? 0 : Math.cos(yaw);
    this.box(
      x - hw + (fx > 0 ? hw : 0.02),
      z - hd + (fz > 0 ? hd : 0.02),
      x + hw - (fx < 0 ? hw : 0.02),
      z + hd - (fz < 0 ? hd : 0.02),
      0.56,
      0.6,
      0x7fb6c9,
    );
    const hx = x - fx * (hw - 0.3);
    const hz = z - fz * (hd - 0.3);
    this.box(hx - 0.34, hz - 0.2, hx + 0.34, hz + 0.2, 0.56, 0.64, 0xffffff);
    // The head of the bed, and a drip beside it.
    const ex = x - fx * hw;
    const ez = z - fz * hd;
    this.box(ex - 0.5, ez - 0.03, ex + 0.5, ez + 0.03, 0.1, 0.95, 0xcfd8db);
    const ivx = ex + 0.72;
    this.box(ivx - 0.015, ez - 0.015, ivx + 0.015, ez + 0.015, 0, 1.85, STEEL);
    this.box(ivx - 0.05, ez - 0.03, ivx + 0.05, ez + 0.03, 1.55, 1.8, 0xd9eef2);
    this.beds.push({ x: this.x + x, z: this.z + z, yaw });
    return this;
  }

  /** The room in world coordinates. */
  done(
    id: ServiceId,
    name: string,
    spawn: { x: number; z: number; yaw: number },
    opts: { safe: boolean; members: boolean; accent: number },
  ): Interior {
    return {
      id,
      name,
      rect: { x0: this.x, z0: this.z, x1: this.x + this.w, z1: this.z + this.d },
      height: this.h,
      boxes: this.boxes,
      labels: this.labels,
      points: this.points,
      beds: this.beds,
      seats: this.seats,
      props: this.props,
      spawn: { x: this.x + spawn.x, z: this.z + spawn.z, yaw: spawn.yaw },
      ...opts,
    };
  }
}

/**
 * One way through (owner, 2026-10-31): the lobby, the office door, up the aisle to the far end of
 * the office, then right through a doorway into the corridor that runs along the cell fronts.
 *
 *   z 18  +-------------+------------------------+
 *         |  CELLS ->   =  corridor              |
 *         |  desks      +---gate---gate---gate---+
 *         |  aisle    L | cell 1 | cell 2 | cell 3|
 *   z  9  +-door--------+--------+--------+------+
 *         |      lobby     FRONT DESK            |
 *   z  0  +------------- way out ----------------+
 *         x 0          x 13                    x 26
 */
function policeStation(x: number, z: number): Interior {
  const navy = 0x1f3a63;
  const inner = 0xc5cad2;
  const r = new Room(x, z, 26, 18, 3.6);
  r.shell(0xe9e6df, 'tile', 0xe2e4e8, navy, 0).door(13);
  for (const cx of [4.33, 13, 21.67]) r.lamp(cx, 5);
  for (const [cx, cz] of [
    [3.4, 13.8],
    [9.6, 13.8],
    [16.5, 16.3],
    [23, 16.3],
    [15.3, 11.8],
    [19.6, 11.8],
    [23.9, 11.8],
  ] as const)
    r.lamp(cx, cz);
  // A navy band round the walls.
  for (const [x0, z0, x1, z1] of [
    [0, 0.02, 11.8, 0.03],
    [14.2, 0.02, 26, 0.03],
    [0, 17.97, 26, 17.98],
    [0.02, 0, 0.03, 18],
    [25.97, 0, 25.98, 18],
  ] as const)
    r.box(x0, z0, x1, z1, 1.05, 1.25, navy);
  // The lobby: chairs each side of the way out, plants in the corners, the front desk to the
  // right with its staff behind it, and the office door clear to the left.
  r.block(9.5, 6, 20.5, 7, 0, 1.08, navy).box(9.45, 5.95, 20.55, 7.05, 1.08, 1.13, WOOD, 'wood');
  r.chairs(1.4, 5, 0.42, 'north', navy, 'fabric');
  r.chairs(21, 24.6, 0.42, 'north', navy, 'fabric');
  for (const dx of [12, 18]) {
    r.box(dx - 0.28, 6.5, dx + 0.28, 6.55, 1.18, 1.52, DARK);
    r.glow(dx - 0.25, 6.55, dx + 0.25, 6.57, 1.21, 1.49, SCREEN);
    r.chair(dx, 7.95, 'south', 0x4a5364, 'fabric');
  }
  r.prop('plant', 0.8, 8, 0).prop('plant', 25.2, 8, 2);
  r.stop(0.5, 7.7, 1.1, 8.3, 1).stop(24.9, 7.7, 25.5, 8.3, 1);
  r.partition(9, 4.7, 7.7, inner);
  r.label('OFFICE', 6.2, 2.86, 8.88, Math.PI, 2.4, 0.5, '#ffffff', '#1f3a63');
  r.label('POLICE STATION', 15, 2.92, 8.88, Math.PI, 5.4, 0.56, '#ffffff', '#1f3a63');
  r.label('FRONT DESK', 15, 0.72, 5.93, Math.PI, 2.6, 0.34, '#ffd23f', '#14202e');
  r.label('LOS SOLES PD', 5.4, 2.55, 0.04, 0, 5, 0.46, '#ffffff', '#1f3a63');
  r.label('WANTED', 22.4, 2.2, 0.04, 0, 2.4, 0.5, '#d8312b', '#f2ead8');
  r.label('SERVE WITH HONOUR', 23.4, 2.1, 8.88, Math.PI, 4.4, 0.34, '#ffd23f', '#14202e');
  // The office: carpet, two rows of desks either side of the aisle, lockers on the far wall.
  r.box(0, 9.1, 13, 18, 0, 0.008, 0xffffff, 'carpet');
  for (const [dx, dz] of [
    [2.6, 12],
    [9.4, 12],
    [2.6, 15.6],
    [9.4, 15.6],
  ] as const)
    r.desk(dx, dz);
  r.lockers(12.4, 9.4, 14.4, 0x34507a);
  r.label('DUTY LOCKERS', 12.98, 2.5, 11.9, -Math.PI / 2, 3.4, 0.4, '#ffffff', '#1f3a63');
  r.point('locker', 11.3, 11.9, Math.PI / 2, 'Lockers', 2.2);
  r.point('computer', 9.4, 13.7, 0, 'Applications');
  // The far end of the office: the only way to the cells.
  r.crossWall(13, 9.1, 18, 14.8, 17.3, inner);
  r.label('HOLDING CELLS', 12.94, 2.86, 16.05, -Math.PI / 2, 2.4, 0.42, '#ffffff', '#1f3a63');
  r.label('CELLS →', 8.6, 2.2, 17.96, Math.PI, 2.2, 0.42, '#ffd23f', '#14202e');
  // The corridor and three holding cells, for later: bare floor, a barred front on z = 14.5 with
  // its gate standing open, a bench on the back wall of each.
  r.box(13.2, 9.1, 26, 14.5, 0, 0.008, 0xaeb3b9, 'tile');
  r.block(17.4, 9.1, 17.55, 14.45, 0, 3.6, inner, 'plaster');
  r.block(21.7, 9.1, 21.85, 14.45, 0, 3.6, inner, 'plaster');
  r.box(13.2, 14.45, 26, 14.53, 2.4, 3.6, inner, 'plaster');
  for (const [i, [a, b]] of (
    [
      [13.2, 17.4],
      [17.55, 21.7],
      [21.85, 26],
    ] as const
  ).entries()) {
    const gate0 = (a + b) / 2 - 0.65;
    const gate1 = gate0 + 1.3;
    r.label(`CELL ${i + 1}`, (a + b) / 2, 2.86, 14.55, 0, 1.3, 0.42, '#ffffff', '#1f3a63');
    for (const [c, d] of [
      [a, gate0],
      [gate1, b],
    ] as const) {
      r.stop(c, 14.45, d, 14.53, 2.4);
      for (let bx = c + 0.1; bx < d; bx += 0.3) r.box(bx, 14.47, bx + 0.05, 14.51, 0, 2.4, STEEL);
      r.box(c, 14.45, d, 14.53, 1.15, 1.22, STEEL);
      r.box(c, 14.45, d, 14.53, 0, 0.1, STEEL);
    }
    r.box(gate0 - 0.06, 14.44, gate0, 14.54, 0, 2.4, DARK);
    r.box(gate1, 14.44, gate1 + 0.06, 14.54, 0, 2.4, DARK);
    // The gate, standing open into the cell.
    r.stop(gate0 - 0.03, 13.18, gate0 + 0.03, 14.45, 2.2);
    for (let bz = 13.2; bz < 14.4; bz += 0.3)
      r.box(gate0 - 0.02, bz, gate0 + 0.02, bz + 0.05, 0.1, 2.2, STEEL);
    r.box(gate0 - 0.03, 13.18, gate0 + 0.03, 14.45, 2.14, 2.2, DARK);
    r.box(gate0 - 0.03, 13.18, gate0 + 0.03, 14.45, 0.08, 0.14, DARK);
    r.box(gate0 - 0.03, 13.18, gate0 + 0.03, 14.45, 1.12, 1.18, DARK);
    const [s0, s1] = [a + 0.6, b - 0.6];
    r.stop(s0, 9.3, s1, 9.9, 0.42);
    r.box(s0, 9.3, s1, 9.9, 0.34, SEAT_Y, 0x6d7782);
    for (const lx of [s0 + 0.1, s1 - 0.2]) r.box(lx, 9.4, lx + 0.1, 9.8, 0, 0.34, 0x565f69);
    for (const f of [0.75, 2.25]) r.seats.push({ x: r.x + s0 + f, z: r.z + 9.6, yaw: 0 });
  }
  return r.done(
    'police',
    'Police Station',
    { x: 13, z: DOOR.spawnZ, yaw: 0 },
    {
      safe: true,
      members: false,
      accent: 0x3d8bff,
    },
  );
}

function hospital(x: number, z: number): Interior {
  const teal = 0x1f8a8c;
  const r = new Room(x, z, 30, 22, 3.6);
  r.shell(0xfdfdfb, 'tile', 0xf6f8f8, teal, 4).door(21);
  r.box(0, 0.02, 19.8, 0.03, 0.9, 1.05, teal);
  r.box(22.2, 0.02, 30, 0.03, 0.9, 1.05, teal);
  r.box(0, 21.97, 30, 21.98, 0.9, 1.05, teal);
  r.box(0.02, 0, 0.03, 22, 0.9, 1.05, teal);
  r.box(29.97, 0, 29.98, 22, 0.9, 1.05, teal);
  // The counter: reception and the pharmacy, with shelves behind.
  r.block(3, 6, 15, 7, 0, 1.08, teal).box(2.95, 5.95, 15.05, 7.05, 1.08, 1.13, 0xf7f8f8);
  r.box(4.3, 6.45, 4.86, 6.5, 1.18, 1.52, DARK).glow(4.33, 6.43, 4.83, 6.45, 1.21, 1.49, SCREEN);
  r.block(3, 9.3, 15, 9.8, 0, 2.3, 0xe7edef);
  for (const y of [0.62, 1.22, 1.82]) r.box(3, 9.16, 15, 9.3, y - 0.03, y, 0xbcc8cc);
  for (let sx = 3.3; sx < 14.8; sx += 0.6)
    for (const y of [0.62, 1.22, 1.82])
      r.box(
        sx,
        9.2,
        sx + 0.42,
        9.3,
        y,
        y + 0.34,
        [0xd8504a, 0x3fa7d6, 0xf2c14e][((sx * 3 + y) % 3) | 0]!,
      );
  r.label('PHARMACY', 9, 2.75, 9.28, Math.PI, 5, 0.6, '#ffffff', '#1f8a8c');
  r.label('RECEPTION', 9, 0.72, 5.93, Math.PI, 2.6, 0.34, '#ffffff', '#14505a');
  r.label('✚', 26.1, 2.3, 0.04, 0, 0.9, 0.9, '#d8312b', '#ffffff');
  r.label('WAITING ROOM', 26.1, 1.55, 0.04, 0, 3, 0.34, '#ffffff', '#1f8a8c');
  r.point('counter', 9, 5.2, Math.PI, 'Counter', 2.4);
  r.point('computer', 4.6, 5.2, Math.PI, 'Applications', 1.6);
  r.chairs(24.4, 28.8, 7.6, 'south', 0x3b8c8e);
  r.chairs(23.8, 28.8, 0.42, 'north', 0x3b8c8e);
  r.box(25, 3.4, 27.6, 4.4, 0.36, 0.4, WOOD, 'wood').stop(25, 3.4, 27.6, 4.4, 0.4);
  for (const [a, b] of [
    [25.1, 3.5],
    [27.4, 3.5],
    [25.1, 4.3],
    [27.4, 4.3],
  ] as const)
    r.box(a, b, a + 0.05, b + 0.05, 0, 0.36, STEEL);
  r.prop('plant', 1.1, 1.1, 0).prop('plant', 29, 9, 1);
  r.stop(0.8, 0.8, 1.4, 1.4, 1).stop(28.7, 8.7, 29.3, 9.3, 1);
  // The ward, through a doorway: beds along the north wall and the partition, curtains between.
  r.partition(10, 19, 23, 0xe9eeef);
  r.label('WARD', 21, 2.92, 9.84, Math.PI, 1.8, 0.45, '#ffffff', '#1f8a8c');
  for (let i = 0; i < 5; i += 1) {
    const bx = 3 + i * 5;
    r.bed(bx, 20.4, Math.PI);
    r.block(bx + 1.4, 19.3, bx + 1.5, 22, 0, 2.2, 0xbcd7d9);
    r.box(bx + 1.38, 19.3, bx + 1.52, 22, 2.2, 2.26, STEEL);
  }
  for (let i = 0; i < 3; i += 1) r.bed(3 + i * 5, 11.6, 0);
  r.lockers(29.4, 11, 16, 0x2b9a9c);
  r.label('STAFF', 29.38, 2.5, 13.5, -Math.PI / 2, 1.8, 0.4, '#ffffff', '#1f8a8c');
  r.point('locker', 28.2, 13.5, Math.PI / 2, 'Lockers', 2.2);
  return r.done(
    'hospital',
    'Hospital',
    { x: 21, z: DOOR.spawnZ, yaw: 0 },
    {
      safe: true,
      members: false,
      accent: 0xff5a52,
    },
  );
}

function gangHouse(id: 'vipers' | 'kings', x: number, z: number): Interior {
  const vipers = id === 'vipers';
  const accent = vipers ? 0x37d67a : 0xf2c14e;
  const name = vipers ? 'Vipers House' : 'Kings House';
  const r = new Room(x, z, 20, 16, 3.2);
  r.shell(0xe6d4c0, 'wood_floor', 0x4a4148, 0x1e1a1e, 2).door(10);
  // A rug, two sofas at a low table, the bar, the pool table, the boss's desk.
  r.box(2, 9.4, 8.6, 14, 0, 0.012, vipers ? 0x2c6e49 : 0x9a7a26, 'fabric');
  r.prop('sofa', 3.3, 13.1, Math.PI).stop(2.1, 12.6, 4.5, 13.6, 0.45);
  r.prop('sofa', 6.5, 13.1, Math.PI).stop(5.3, 12.6, 7.7, 13.6, 0.45);
  for (const sx of [2.75, 3.85, 5.95, 7.05])
    r.seats.push({ x: r.x + sx, z: r.z + 12.85, yaw: Math.PI });
  r.block(3.6, 10.2, 6.4, 11.4, 0.34, 0.4, WOOD, 'wood');
  for (const [a, b] of [
    [3.7, 10.3],
    [6.2, 10.3],
    [3.7, 11.2],
    [6.2, 11.2],
  ] as const)
    r.box(a, b, a + 0.08, b + 0.08, 0, 0.34, DARK);
  r.stop(3.6, 10.2, 6.4, 11.4, 0.4);
  r.block(12, 14.6, 19.6, 15.6, 0, 1.1, WOOD, 'wood').box(
    11.95,
    14.55,
    19.65,
    15.65,
    1.1,
    1.15,
    DARK,
  );
  for (let bx = 12.4; bx < 19.4; bx += 0.5) {
    r.box(
      bx,
      15.62,
      bx + 0.14,
      15.74,
      1.5,
      1.85,
      [0x7a3b1d, 0x2c6e49, 0xb7b7a4][((bx * 2) % 3) | 0]!,
    );
    r.box(bx - 0.08, 15.6, bx + 0.22, 15.76, 1.46, 1.5, WOOD, 'wood');
  }
  for (const sx of [13, 14.4, 15.8, 17.2, 18.6]) r.chair(sx, 14, 'north', 0x6a4a3a, 'fabric');
  r.block(11, 6, 16, 8.6, 0, 0.78, WOOD, 'wood').box(
    11.15,
    6.15,
    15.85,
    8.45,
    0.78,
    0.84,
    0x1f7a4c,
    'fabric',
  );
  r.box(10.9, 5.9, 16.1, 6.1, 0.78, 0.88, WOOD, 'wood');
  r.box(10.9, 8.5, 16.1, 8.7, 0.78, 0.88, WOOD, 'wood');
  r.box(10.9, 5.9, 11.1, 8.7, 0.78, 0.88, WOOD, 'wood');
  r.box(15.9, 5.9, 16.1, 8.7, 0.78, 0.88, WOOD, 'wood');
  r.desk(4, 6);
  r.point('computer', 4, 4.2, 0, 'Applications');
  r.prop('plant', 1, 15, 0.7).stop(0.7, 14.7, 1.3, 15.3, 1);
  r.label(id.toUpperCase(), 10, 2.05, 15.96, Math.PI, 7, 1.5, `#${accent.toString(16)}`, '#1a161a');
  r.glow(0.02, 0, 0.05, 16, 3.05, 3.1, accent);
  r.glow(19.95, 0, 19.98, 16, 3.05, 3.1, accent);
  return r.done(
    id,
    name,
    { x: 10, z: DOOR.spawnZ, yaw: 0 },
    { safe: false, members: true, accent },
  );
}

export const INTERIORS: Record<ServiceId, Interior> = {
  police: policeStation(ORIGIN_X, ORIGIN_Z),
  hospital: hospital(ORIGIN_X + SPACING, ORIGIN_Z),
  vipers: gangHouse('vipers', ORIGIN_X + SPACING * 2, ORIGIN_Z),
  kings: gangHouse('kings', ORIGIN_X + SPACING * 3, ORIGIN_Z),
};

const ROOMS = Object.values(INTERIORS);

/** The room at (x, z), if any. */
export function interiorAt(x: number, z: number): Interior | null {
  if (x < ORIGIN_X - 2) return null;
  for (const room of ROOMS) {
    const r = room.rect;
    if (x >= r.x0 - 1 && x <= r.x1 + 1 && z >= r.z0 - 1 && z <= r.z1 + 1) return room;
  }
  return null;
}

/** Every room's walls and solid furniture, in world coordinates. */
export function interiorSolids(): Solid[] {
  return ROOMS.flatMap((room) =>
    room.boxes
      .filter((b) => b.solid)
      .map((b) => ({
        x0: room.rect.x0 + b.x0,
        z0: room.rect.z0 + b.z0,
        x1: room.rect.x0 + b.x1,
        z1: room.rect.z0 + b.z1,
        y0: b.y0,
        y1: b.y1,
      })),
  );
}
