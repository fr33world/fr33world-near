/**
 * The job sites' furniture (city `points`, Phase 6): Courier Depot's parcel lockers on the plaza
 * (painted doors, a lit header), the quarry's site office (a yellow cabin with its sign), the
 * ore faces (rough boulders streaked with their ore: copper green-orange, iron rust, gold) and
 * Harbor Metals' sign on Dock Street. Original names and art; signs light up at night. Their
 * collision boxes are the city's (points.ts).
 */
import { type CityLayout, heightRange, LOCKERS, ORE_SIZE } from '@fr33world/city';
import * as THREE from 'three';

const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d') as CanvasRenderingContext2D);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The lockers' front: a header with the name, then rows of small doors with handles. */
const lockerFront = () =>
  canvas(512, 384, (g) => {
    g.fillStyle = '#1b2a3a';
    g.fillRect(0, 0, 512, 384);
    g.fillStyle = '#ff7a1a';
    g.fillRect(0, 0, 512, 70);
    g.fillStyle = '#ffffff';
    g.font = `900 46px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('COURIER DEPOT', 256, 52, 480);
    for (let r = 0; r < 4; r += 1)
      for (let c = 0; c < 6; c += 1) {
        const x = 14 + c * 82;
        const y = 82 + r * 74;
        g.fillStyle = r === 3 && c === 2 ? '#26394d' : '#2f4760';
        g.fillRect(x, y, 74, 66);
        g.fillStyle = '#9fb3c8';
        g.fillRect(x + 60, y + 26, 6, 14);
      }
    // The screen where couriers sign for their packages.
    g.fillStyle = '#7def06';
    g.fillRect(14 + 2 * 82 + 10, 82 + 3 * 74 + 12, 54, 30);
  });

const officeSign = () =>
  canvas(512, 128, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#1e2a33';
    g.font = `900 52px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('SITE OFFICE', 256, 62, 490);
    g.font = `700 30px ${FONT}`;
    g.fillStyle = '#c0571b';
    g.fillText('LOS SOLES QUARRY · SIGN ON HERE', 256, 106, 490);
  });

const buyerSign = () =>
  canvas(512, 192, (g) => {
    g.fillStyle = '#0e3b4a';
    g.fillRect(0, 0, 512, 192);
    g.strokeStyle = '#e8b04a';
    g.lineWidth = 8;
    g.strokeRect(10, 10, 492, 172);
    g.fillStyle = '#e8b04a';
    g.font = `900 58px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('HARBOR METALS', 256, 88, 470);
    g.fillStyle = '#ffffff';
    g.font = `700 32px ${FONT}`;
    g.fillText('ORE BOUGHT · COPPER · IRON · GOLD', 256, 146, 470);
  });

/** A rough boulder: an icosahedron pushed in and out, streaked with its ore's colour. */
function boulder(seed: number, ore: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(ORE_SIZE / 2, 2).toNonIndexed();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const colours: number[] = [];
  const rock = new THREE.Color(0x3b3631);
  const v = new THREE.Vector3();
  // Stable per vertex position, so shared corners move together.
  const noise = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    const n = noise(Math.round(v.x * 50), Math.round(v.y * 50), Math.round(v.z * 50));
    v.multiplyScalar(0.82 + n * 0.32);
    v.y = v.y * 0.72 + 0.7;
    pos.setXYZ(i, v.x, Math.max(0, v.y), v.z);
    const streak = Math.sin(v.x * 3.1 + v.y * 5.3 + seed) > 0.55 ? 1 : 0;
    const c = rock
      .clone()
      .lerp(ore, streak * 0.85)
      .multiplyScalar(0.85 + n * 0.3);
    colours.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  g.computeVertexNormals();
  return g;
}

const ORE_COLOURS = [
  new THREE.Color(0x3fa37a),
  new THREE.Color(0x9a3d1f),
  new THREE.Color(0xf2c230),
];

export function buildJobSites(city: CityLayout): {
  group: THREE.Group;
  update(night: number): void;
} {
  const group = new THREE.Group();
  group.name = 'job-sites';
  const ground = (x: number, z: number) => heightRange(city, x, z).top;
  const glow: THREE.MeshStandardMaterial[] = [];
  const lit = (map: THREE.Texture) => {
    const m = new THREE.MeshStandardMaterial({
      map,
      emissiveMap: map,
      emissive: 0xffffff,
      emissiveIntensity: 0.15,
      roughness: 0.5,
    });
    glow.push(m);
    return m;
  };
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.5, metalness: 0.6 });
  const rockMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    flatShading: true,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0.15,
    flatShading: true,
  });

  city.points.forEach((p, i) => {
    // The furniture stands behind the point (the point is where the player stands).
    const back = (d: number) => ({ x: p.x - Math.sin(p.yaw) * d, z: p.z - Math.cos(p.yaw) * d });
    if (p.kind === 'depot') {
      const at = back(1.6);
      const g = new THREE.Group();
      g.position.set(at.x, ground(at.x, at.z), at.z);
      g.rotation.y = p.yaw;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(LOCKERS.width, LOCKERS.height, LOCKERS.depth),
        metal,
      );
      body.position.y = LOCKERS.height / 2;
      body.castShadow = true;
      const front = new THREE.Mesh(
        new THREE.PlaneGeometry(LOCKERS.width - 0.06, LOCKERS.height - 0.1),
        lit(lockerFront()),
      );
      front.position.set(0, LOCKERS.height / 2, LOCKERS.depth / 2 + 0.005);
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(LOCKERS.width + 0.3, 0.08, LOCKERS.depth + 0.4),
        metal,
      );
      roof.position.set(0, LOCKERS.height + 0.04, 0.1);
      g.add(body, front, roof);
      group.add(g);
    } else if (p.kind === 'quarry_office') {
      const at = back(3.5);
      const g = new THREE.Group();
      g.position.set(at.x, ground(at.x, at.z), at.z);
      g.rotation.y = p.yaw;
      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(5, 2.7, 3),
        new THREE.MeshStandardMaterial({ color: 0xe0a92a, roughness: 0.6, metalness: 0.3 }),
      );
      cabin.position.y = 1.5;
      cabin.castShadow = true;
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(5.1, 0.15, 3.1), metal);
      skirt.position.y = 0.1;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 2), metal);
      door.position.set(-1.4, 1.2, 1.505);
      const win = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 0.9),
        new THREE.MeshStandardMaterial({
          color: 0x9cc9e0,
          roughness: 0.1,
          metalness: 0.4,
          emissive: 0xffd9a0,
          emissiveIntensity: 0,
        }),
      );
      win.position.set(0.9, 1.7, 1.505);
      glow.push(win.material);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), lit(officeSign()));
      sign.position.set(0, 3.3, 1.2);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 0.1), metal);
      post.position.set(0, 2.95, 1.2);
      g.add(cabin, skirt, door, win, sign, post);
      group.add(g);
    } else if (p.kind === 'ore') {
      const grade = p.grade ?? 0;
      const at = { x: p.x, z: p.z - ORE_SIZE / 2 - 1 };
      const m = new THREE.Mesh(
        boulder(i * 7.3, ORE_COLOURS[grade] as THREE.Color),
        grade === 2 ? goldMat : rockMat,
      );
      m.position.set(at.x, ground(at.x, at.z), at.z);
      m.rotation.y = i * 1.7;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    } else if (p.kind === 'buyer') {
      const at = back(1.4);
      const g = new THREE.Group();
      g.position.set(at.x, ground(at.x, at.z), at.z);
      g.rotation.y = p.yaw;
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), lit(buyerSign()));
      board.position.y = 2.6;
      const back2 = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.3, 0.08), metal);
      back2.position.set(0, 2.6, -0.05);
      for (const x of [-1.4, 1.4]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.2, 0.12), metal);
        post.position.set(x, 1.6, -0.1);
        g.add(post);
      }
      // A scale on a pallet in front of it.
      const scale = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.9), metal);
      scale.position.set(0.9, 0.06, 0.3);
      g.add(board, back2, scale);
      group.add(g);
    }
  });

  return {
    group,
    update(night: number) {
      for (const m of glow) m.emissiveIntensity = 0.15 + night * 0.85;
    },
  };
}
