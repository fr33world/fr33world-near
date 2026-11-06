/**
 * The public buildings from the street (city `entrance` points): a lit sign over the door, a
 * canopy and a doorway on the front, and on the sidewalk a marker like a car park's, its ring and
 * beam in the place's colour. Stepping into it goes inside (Game). Each site is hidden from afar.
 */
import { type CityLayout, type InteractionPoint, INTERIORS, type ServiceId } from '@fr33world/city';
import * as THREE from 'three';
import { SLAB_Y } from './city.ts';
import { GeoBuilder } from './geo.ts';
import { beamTexture, MARKER_RADIUS, markerTexture } from './parking.ts';

const FONT = `'Bebas Neue', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
/** Past this (m), a site's sign and marker aren't drawn. */
const DRAW_M = 450;

const LOOK: Record<ServiceId, { text: string; back: string; ink: string; glyph: string }> = {
  police: { text: 'POLICE STATION', back: '#1f3a63', ink: '#ffffff', glyph: '★' },
  hospital: { text: 'HOSPITAL', back: '#ffffff', ink: '#d8312b', glyph: '✚' },
  vipers: { text: 'VIPERS', back: '#101512', ink: '#37d67a', glyph: 'V' },
  kings: { text: 'KINGS', back: '#15120a', ink: '#f2c14e', glyph: 'K' },
  market: { text: 'LOS SOLES MARKET', back: '#1f6e40', ink: '#ffffff', glyph: '◆' },
};

function signTexture(id: ServiceId): THREE.CanvasTexture {
  const { text, back, ink } = LOOK[id];
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 192;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = back;
  g.fillRect(0, 0, 1024, 192);
  g.fillStyle = ink;
  g.font = `400 150px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 512, 104, 980);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function site(p: InteractionPoint, beam: THREE.BufferGeometry, beamMap: THREE.Texture) {
  const id = p.service as ServiceId;
  const front = p.front as { x: number; z: number };
  const room = INTERIORS[id];
  const group = new THREE.Group();
  group.name = `service-${id}`;
  const out = { x: Math.sin(p.yaw), z: Math.cos(p.yaw) };
  const gang = room.members;
  const signW = gang ? 8 : 16;
  const signY = gang ? 4.4 : 5.4;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(signW, (signW * 192) / 1024),
    new THREE.MeshBasicMaterial({ map: signTexture(id), toneMapped: false }),
  );
  sign.position.set(front.x + out.x * 0.2, SLAB_Y + signY, front.z + out.z * 0.2);
  sign.rotation.y = p.yaw;
  group.add(sign);
  // The doorway and the canopy over it.
  const box = (out0: number, out1: number, half: number, y0: number, y1: number) => {
    const cx = front.x + (out.x * (out0 + out1)) / 2;
    const cz = front.z + (out.z * (out0 + out1)) / 2;
    const along = Math.abs(out.x) > 0.5;
    const hx = along ? (out1 - out0) / 2 : half;
    const hz = along ? half : (out1 - out0) / 2;
    return new GeoBuilder()
      .box(cx - hx, SLAB_Y + y0, cz - hz, cx + hx, SLAB_Y + y1, cz + hz, 1)
      .build();
  };
  const door = new THREE.Mesh(
    box(0, 0.1, 2, 0, 2.8),
    new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.25, metalness: 0.5 }),
  );
  const canopy = new THREE.Mesh(
    box(0, 2.9, 3.2, 3.1, 3.35),
    new THREE.MeshBasicMaterial({ color: room.accent, toneMapped: false }),
  );
  group.add(door, canopy);
  // The marker on the sidewalk.
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(p.radius * 2, p.radius * 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: markerTexture(LOOK[id].glyph),
      color: room.accent,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -10,
      polygonOffsetUnits: -10,
    }),
  );
  ring.position.set(p.x, SLAB_Y + 0.04, p.z);
  ring.renderOrder = 2;
  const shaft = new THREE.Mesh(
    beam,
    new THREE.MeshBasicMaterial({
      map: beamMap,
      color: room.accent,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  shaft.position.set(p.x, SLAB_Y + 0.04, p.z);
  shaft.scale.set(p.radius / MARKER_RADIUS, 1, p.radius / MARKER_RADIUS);
  shaft.renderOrder = 3;
  group.add(ring, shaft);
  return { group, x: p.x, z: p.z };
}

export function buildServices(city: CityLayout): {
  group: THREE.Group;
  update(eye: THREE.Vector3): void;
} {
  const group = new THREE.Group();
  group.name = 'services';
  const beam = new THREE.CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS, 7, 24, 1, true).translate(
    0,
    3.5,
    0,
  );
  const map = beamTexture();
  const sites = city.points.filter((p) => p.kind === 'entrance').map((p) => site(p, beam, map));
  for (const s of sites) group.add(s.group);
  return {
    group,
    update(eye) {
      for (const s of sites) s.group.visible = Math.hypot(s.x - eye.x, s.z - eye.z) < DRAW_M;
    },
  };
}
