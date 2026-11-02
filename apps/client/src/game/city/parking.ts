/**
 * The car parks (city `parking`, owner 2026-10-30): asphalt over the lot, white lines marking
 * each bay, a blue P sign at the entrance, lit at night, and just inside it a marker like a
 * delivery stop's: a P on the ground in a glowing ring under a beam of light. Stepping into
 * it opens the car picker (Game). Every lot in a handful of merged or instanced meshes (six
 * draw calls for all of them).
 */
import { type CityLayout, type InteractionPoint, lotHeight } from '@fr33world/city';
import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';

const BAY_W = 2.7;
const BAY_L = 5.4;
const LINE = 0.12;
/** The marker: how far inside the entrance it stands (m), and its ring's radius. */
const MARKER_IN = 2;
export const MARKER_RADIUS = 1.7;
const MARKER_BLUE = 0x3d8bff;

/** Where a car park's marker stands: just inside its entrance (the point faces the street). */
export function parkingMarker(p: Pick<InteractionPoint, 'x' | 'z' | 'yaw'>): {
  x: number;
  z: number;
} {
  return { x: p.x - Math.sin(p.yaw) * MARKER_IN, z: p.z - Math.cos(p.yaw) * MARKER_IN };
}

/** A marker's floor: a ring round a letter, white (tinted by the material). */
export function markerTexture(glyph = 'P'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 16;
  g.beginPath();
  g.arc(128, 128, 116, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.beginPath();
  g.arc(128, 128, 104, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = `900 140px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(glyph, 128, 138);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A marker's beam: brightest at the ground, fading out upwards. */
export function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(255,255,255,0.75)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

function signTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#1659c7';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 112, 112);
  g.fillStyle = '#ffffff';
  g.font = `900 92px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('P', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildParking(
  city: CityLayout,
  asphalt: THREE.Material,
): { group: THREE.Group; update(night: number): void } {
  const group = new THREE.Group();
  group.name = 'parking';
  if (city.parking.length === 0) return { group, update() {} };
  const ground = new GeoBuilder();
  const lines: number[] = [];
  const quad = (
    cx: number,
    cz: number,
    y: number,
    ax: number,
    az: number,
    along: number,
    across: number,
  ) => {
    // A flat rectangle centred at (cx, cz), `along` metres in direction (ax, az), `across` wide.
    const bx = -az;
    const bz = ax;
    const p = (u: number, v: number) => [cx + ax * u + bx * v, y, cz + az * u + bz * v];
    const [a, b, c, d] = [
      p(-along / 2, -across / 2),
      p(along / 2, -across / 2),
      p(along / 2, across / 2),
      p(-along / 2, across / 2),
    ];
    lines.push(...a, ...c, ...b, ...a, ...d, ...c);
  };
  const posts: THREE.Matrix4[] = [];
  const markers: THREE.Matrix4[] = [];
  for (const lot of city.parking) {
    const r = lot.rect;
    const y = lotHeight(city, r);
    ground.flat(r.x0, r.z0, r.x1, r.z1, y, 8);
    for (const bay of lot.bays) {
      const fx = Math.sin(bay.yaw);
      const fz = Math.cos(bay.yaw);
      // Side lines of the bay, and the line at its back.
      for (const side of [-1, 1])
        quad(
          bay.x + fz * side * (BAY_W / 2),
          bay.z - fx * side * (BAY_W / 2),
          y + 0.02,
          fx,
          fz,
          BAY_L,
          LINE,
        );
      quad(bay.x - fx * (BAY_L / 2), bay.z - fz * (BAY_L / 2), y + 0.02, -fz, fx, BAY_W, LINE);
    }
    // The sign: beside the entrance, facing the street.
    const e = lot.entrance;
    const side = { x: Math.cos(e.yaw), z: -Math.sin(e.yaw) };
    posts.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(e.x + side.x * 4.2, y, e.z + side.z * 4.2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), e.yaw),
        new THREE.Vector3(1, 1, 1),
      ),
    );
    const m = parkingMarker(e);
    markers.push(new THREE.Matrix4().makeTranslation(m.x, y + 0.04, m.z));
  }
  const lot = new THREE.Mesh(ground.build(), asphalt);
  lot.receiveShadow = true;
  lot.name = 'parking-lots';
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  // Flat on the ground: normals straight up, both faces drawn (the quads' winding varies).
  lineGeometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      Array.from({ length: lines.length / 3 }, () => [0, 1, 0]).flat(),
      3,
    ),
  );
  const paint = new THREE.MeshStandardMaterial({
    color: 0xf2f2ee,
    roughness: 0.8,
    side: THREE.DoubleSide,
    // Over the asphalt, which itself draws with a depth bias over the ground.
    polygonOffset: true,
    polygonOffsetFactor: -8,
    polygonOffsetUnits: -8,
  });
  const marks = new THREE.Mesh(lineGeometry, paint);
  marks.receiveShadow = true;
  marks.name = 'parking-lines';

  // Signs: a pole and a P panel, instanced.
  const pole = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8).translate(0, 1.3, 0),
    new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 0.7, roughness: 0.4 }),
    posts.length,
  );
  const tex = signTexture();
  const panelMaterial = new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: 0.15,
  });
  const panel = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.8, 0.8, 0.06).translate(0, 2.9, 0),
    panelMaterial,
    posts.length,
  );
  posts.forEach((m, i) => {
    pole.setMatrixAt(i, m);
    panel.setMatrixAt(i, m);
  });
  // The markers: the floor ring and the beam over it, instanced (two draw calls for all).
  const floorMaterial = new THREE.MeshBasicMaterial({
    map: markerTexture(),
    color: MARKER_BLUE,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -10,
    polygonOffsetUnits: -10,
  });
  const floor = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(MARKER_RADIUS * 2, MARKER_RADIUS * 2).rotateX(-Math.PI / 2),
    floorMaterial,
    markers.length,
  );
  const beamMaterial = new THREE.MeshBasicMaterial({
    map: beamTexture(),
    color: MARKER_BLUE,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS, 7, 24, 1, true).translate(0, 3.5, 0),
    beamMaterial,
    markers.length,
  );
  markers.forEach((m, i) => {
    floor.setMatrixAt(i, m);
    beam.setMatrixAt(i, m);
  });
  floor.renderOrder = 2;
  beam.renderOrder = 3;
  floor.name = 'parking-markers';
  group.add(lot, marks, pole, panel, floor, beam);
  return {
    group,
    update(night: number) {
      panelMaterial.emissiveIntensity = 0.15 + night * 0.9;
      // A slow breath, so it reads as something to step into.
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 450);
      floorMaterial.opacity = 0.7 + 0.3 * pulse;
      beamMaterial.opacity = 0.55 + 0.25 * pulse + 0.2 * night;
    },
  };
}
