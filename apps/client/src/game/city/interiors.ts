/**
 * The rooms (city `INTERIORS`), drawn with their light painted in, so they look the same day and
 * night and stay cheap: one merged mesh per surface (plaster, tile, wood, cloth...) with what the
 * ceiling lights give each point in its vertex colours, darker into corners and under furniture,
 * then the furniture models, wall plates and floor markers. A room is built the first time
 * someone goes in; the game hides the city while it shows. Textures: scripts/assets/room-textures.mjs.
 */
import {
  type Interior,
  INTERIORS,
  type RoomBox,
  type RoomPoint,
  type RoomProp,
  type RoomTexture,
  type ServiceId,
} from '@fr33world/city';
import * as THREE from 'three';
import { beamTexture, markerTexture } from './parking.ts';
import { prepareProp } from './props.ts';

const FONT = `'Bebas Neue', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

/** How many metres one repeat of each surface covers. */
const TILE: Record<RoomTexture, number> = {
  plaster: 3,
  tile: 3.6,
  wood_floor: 2.4,
  carpet: 2,
  ceiling: 2.4,
  wood: 1.4,
  fabric: 0.8,
};
/** Long surfaces are cut this small (m), so the painted light can vary along them. */
const CELL_FLOOR = 0.5;
const CELL_WALL = 1;

const AMBIENT = 0.5;
const LAMP = 0.62;
/** How far a ceiling light reaches (m). */
const LAMP_REACH = 4.6;
/** How far the dark at the foot of furniture and walls spreads (m), and how dark it gets. */
const CONTACT_M = 0.55;
const CONTACT_DARK = 0.42;

interface Light {
  x: number;
  y: number;
  z: number;
}

/** Every ceiling light, in world coordinates. */
function lampsOf(room: Interior): Light[] {
  const { x0: ox, z0: oz } = room.rect;
  return room.boxes
    .filter((b) => b.glow && b.y0 >= room.height - 0.2)
    .map((b) => ({ x: ox + (b.x0 + b.x1) / 2, y: b.y0, z: oz + (b.z0 + b.z1) / 2 }));
}

/** What stands on the floor: where it's dark at the foot of things. */
function footprints(room: Interior): RoomBox[] {
  return room.boxes.filter((b) => b.solid && b.y0 < 0.2 && b.y1 - b.y0 > 0.3);
}

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/** The light at a point looking along (nx, ny, nz). */
function lightAt(
  room: Interior,
  lamps: Light[],
  feet: RoomBox[],
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  let lit = AMBIENT + 0.06 * ny + 0.04 * nz;
  for (const l of lamps) {
    const dx = l.x - x;
    const dy = l.y - y;
    const dz = l.z - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const d = Math.sqrt(d2) || 1;
    const facing = Math.max(0, (dx * nx + dy * ny + dz * nz) / d);
    lit += (LAMP * (0.3 + 0.7 * facing)) / (1 + d2 / (LAMP_REACH * LAMP_REACH));
  }
  // Lower down the walls is a little darker, and darker yet at the floor.
  const low = ny > 0.5 ? 0 : 1 - smooth(y / 1.1);
  lit *= 1 - 0.2 * low;
  // At the foot of walls and furniture (the floor, and the bottom of the walls).
  if (y < 0.7) {
    const lx = x - room.rect.x0;
    const lz = z - room.rect.z0;
    const w = room.rect.x1 - room.rect.x0;
    const d = room.rect.z1 - room.rect.z0;
    let near = ny > 0.5 ? Math.min(lx, lz, w - lx, d - lz) : CONTACT_M;
    if (ny > 0.5)
      for (const b of feet) {
        const dx = Math.max(b.x0 - lx, 0, lx - b.x1);
        const dz = Math.max(b.z0 - lz, 0, lz - b.z1);
        near = Math.min(near, Math.hypot(dx, dz));
      }
    const height = ny > 0.5 ? 1 : 1 - smooth(y / 0.7);
    lit *= 1 - CONTACT_DARK * height * (1 - smooth(near / CONTACT_M));
  }
  return Math.min(1.15, lit);
}

interface Batch {
  positions: number[];
  colours: number[];
  uvs: number[];
}

const newBatch = (): Batch => ({ positions: [], colours: [], uvs: [] });

/** Cells along a side of `size` metres: long sides are cut small enough to carry the light. */
function cells(size: number, cell: number): number {
  return size > 2.5 ? Math.min(90, Math.ceil(size / cell)) : 1;
}

function addBox(room: Interior, lamps: Light[], feet: RoomBox[], b: RoomBox, into: Batch) {
  const { x0: ox, z0: oz } = room.rect;
  const sx = b.x1 - b.x0;
  const sy = b.y1 - b.y0;
  const sz = b.z1 - b.z0;
  const flat = sy < 0.3;
  const cell = flat ? CELL_FLOOR : CELL_WALL;
  const geometry = new THREE.BoxGeometry(sx, sy, sz, cells(sx, cell), 1, cells(sz, cell))
    .translate((b.x0 + b.x1) / 2 + ox, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2 + oz)
    .toNonIndexed();
  const p = geometry.getAttribute('position');
  const n = geometry.getAttribute('normal');
  const c = new THREE.Color(b.colour);
  const repeat = b.tex ? TILE[b.tex] : 1;
  for (let i = 0; i < p.count; i += 1) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const nx = n.getX(i);
    const ny = n.getY(i);
    const nz = n.getZ(i);
    into.positions.push(x, y, z);
    const shade = b.glow ? 1 : lightAt(room, lamps, feet, x, y, z, nx, ny, nz);
    into.colours.push(c.r * shade, c.g * shade, c.b * shade);
    // Laid out in metres, whichever way the face looks.
    if (Math.abs(ny) > 0.5) into.uvs.push((x - ox) / repeat, (z - oz) / repeat);
    else if (Math.abs(nz) > 0.5) into.uvs.push((x - ox) / repeat, y / repeat);
    else into.uvs.push((z - oz) / repeat, y / repeat);
  }
  geometry.dispose();
}

const textures = new Map<RoomTexture, THREE.Texture>();
function surface(tex: RoomTexture): THREE.Texture {
  let t = textures.get(tex);
  if (!t) {
    t = new THREE.TextureLoader().load(`/assets/textures/room_${tex}.webp`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    textures.set(tex, t);
  }
  return t;
}

/** The room's boxes, one mesh per surface. */
function roomMeshes(room: Interior): THREE.Group {
  const group = new THREE.Group();
  group.name = `room-${room.id}`;
  const lamps = lampsOf(room);
  const feet = footprints(room);
  const batches = new Map<RoomTexture | null, Batch>();
  for (const b of room.boxes) {
    if (b.hidden) continue;
    const key = b.tex ?? null;
    let batch = batches.get(key);
    if (!batch) {
      batch = newBatch();
      batches.set(key, batch);
    }
    addBox(room, lamps, feet, b, batch);
  }
  for (const [tex, batch] of batches) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(batch.colours, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
    group.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          toneMapped: false,
          fog: false,
          ...(tex && { map: surface(tex) }),
        }),
      ),
    );
  }
  return group;
}

/** How big each model should stand (m): a plant's height, the others' width. */
const MODEL_SIZE: Record<RoomProp['kind'], number> = { plant: 1.25, sofa: 2.3, desk: 1.55 };
/** The sun is for the street: under it the models glare against the rooms' painted light. */
const MODEL_LIGHT = 0.5;

/** The furniture models of one kind, drawn together. */
async function furniture(kind: RoomProp['kind'], spots: RoomProp[]): Promise<THREE.Object3D> {
  const { geometry, material } = await prepareProp(kind);
  const box = (geometry.boundingBox ?? new THREE.Box3()).getSize(new THREE.Vector3());
  const fit = MODEL_SIZE[kind] / (kind === 'plant' ? box.y : Math.max(box.x, box.z));
  const dimmed = (material as THREE.MeshStandardMaterial).clone();
  dimmed.color.multiplyScalar(MODEL_LIGHT);
  const mesh = new THREE.InstancedMesh(geometry, dimmed, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  spots.forEach((s, i) => {
    q.setFromAxisAngle(up, s.yaw);
    const size = s.scale * fit;
    m.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(size, size, size));
    mesh.setMatrixAt(i, m);
  });
  mesh.frustumCulled = false;
  return mesh;
}

function plate(l: Interior['labels'][number]): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = Math.max(64, Math.round((1024 * l.h) / l.w));
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = l.back;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = l.colour;
  g.font = `400 ${Math.round(c.height * 0.72)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(l.text, c.width / 2, c.height / 2 + c.height * 0.04, c.width * 0.94);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(l.w, l.h),
    new THREE.MeshBasicMaterial({ map, toneMapped: false, fog: false }),
  );
  mesh.position.set(l.x, l.y, l.z);
  mesh.rotation.y = l.yaw;
  return mesh;
}

const GLYPHS: Record<RoomPoint['kind'], string> = {
  exit: '↓',
  locker: 'L',
  counter: '+',
  computer: 'A',
  till: '$',
  join: '?',
  patrol: 'P',
};

function markers(room: Interior): THREE.Group {
  const group = new THREE.Group();
  const accent = room.accent;
  const beam = new THREE.MeshBasicMaterial({
    map: beamTexture(),
    color: accent,
    transparent: true,
    fog: false,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Seen from outside only: a camera stood in the beam would see the whole room tinted.
    side: THREE.FrontSide,
  });
  const beamShape = new THREE.CylinderGeometry(1, 1, 2.4, 20, 1, true).translate(0, 1.2, 0);
  for (const p of room.points) {
    const r = p.kind === 'exit' ? p.radius : 0.8;
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(r * 2, r * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: markerTexture(GLYPHS[p.kind]),
        color: accent,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    );
    ring.position.set(p.x, 0.02, p.z);
    ring.renderOrder = 2;
    group.add(ring);
    if (p.kind === 'exit') {
      const b = new THREE.Mesh(beamShape, beam);
      b.position.set(p.x, 0, p.z);
      b.scale.set(r, 1, r);
      b.renderOrder = 3;
      group.add(b);
    }
  }
  return group;
}

export class InteriorsView {
  readonly group = new THREE.Group();
  private readonly built = new Map<ServiceId, THREE.Group>();
  private shown: ServiceId | null = null;

  constructor() {
    this.group.name = 'interiors';
  }

  /** Puts something in a room, so it shows and hides with it. */
  place(id: ServiceId, thing: THREE.Object3D): void {
    this.built.get(id)?.add(thing);
  }

  /** Shows one room (built the first time), or none. */
  show(id: ServiceId | null): void {
    if (id === this.shown) return;
    if (this.shown) {
      const was = this.built.get(this.shown);
      if (was) was.visible = false;
    }
    this.shown = id;
    if (!id) return;
    let room = this.built.get(id);
    if (!room) {
      const data = INTERIORS[id];
      room = new THREE.Group();
      room.add(roomMeshes(data), markers(data));
      for (const l of data.labels) room.add(plate(l));
      for (const kind of new Set(data.props.map((p) => p.kind))) {
        const spots = data.props.filter((p) => p.kind === kind);
        const into = room;
        // A model that fails to load leaves its spot empty: the room still works.
        void furniture(kind, spots).then(
          (mesh) => into.add(mesh),
          (e: unknown) => console.warn('room furniture', kind, e),
        );
      }
      this.built.set(id, room);
      this.group.add(room);
    }
    room.visible = true;
  }
}
