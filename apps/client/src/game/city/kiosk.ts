/**
 * The info kiosks (city `points` of kind 'info'): a slim charcoal totem on a stone plinth with
 * a city-guide screen on both faces (painted on a canvas at start-up, softly lit by day and
 * bright at night) and a green "i" lamp on top. Its collision box is the city's (points.ts).
 */
import { type CityLayout, KIOSK } from '@fr33world/city';
import * as THREE from 'three';

const SLAB_Y = 0.15;
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
const BRAND = '#7def06';

function screen(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const bg = ctx.createLinearGradient(0, 0, 0, 1024);
  bg.addColorStop(0, '#0d1a24');
  bg.addColorStop(1, '#05080c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 1024);
  // A faint street grid, as on a map.
  ctx.strokeStyle = 'rgba(125, 239, 6, 0.08)';
  ctx.lineWidth = 6;
  for (let i = -2; i < 12; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * 70, 1024);
    ctx.lineTo(i * 70 + 300, 380);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  // The "i".
  ctx.strokeStyle = BRAND;
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(256, 210, 92, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = BRAND;
  ctx.font = `900 140px ${FONT}`;
  ctx.fillText('i', 256, 260);
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 64px ${FONT}`;
  ctx.fillText('LOS SOLES', 256, 410, 460);
  ctx.font = `700 40px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText('CITY GUIDE', 256, 465, 460);
  ctx.font = `600 34px ${FONT}`;
  ['Controls', 'House rules', 'Getting help'].forEach((line, i) => {
    const y = 600 + i * 74;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(64, y - 46, 384, 62);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, 256, y);
  });
  ctx.fillStyle = BRAND;
  ctx.fillRect(64, 880, 384, 72);
  ctx.fillStyle = '#0a0d10';
  ctx.font = `900 36px ${FONT}`;
  ctx.fillText('TAP OR PRESS E', 256, 928, 360);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function buildKiosks(city: CityLayout): {
  group: THREE.Group;
  update(night: number): void;
} {
  const group = new THREE.Group();
  group.name = 'kiosks';
  const spots = city.points.filter((p) => p.kind === 'info');
  if (spots.length === 0) return { group, update() {} };
  const metal = new THREE.MeshStandardMaterial({
    color: 0x24272c,
    roughness: 0.42,
    metalness: 0.7,
  });
  const stone = new THREE.MeshStandardMaterial({ color: 0xb9b2a6, roughness: 0.85 });
  const texture = screen();
  const glass = new THREE.MeshStandardMaterial({
    map: texture,
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: 0.45,
    roughness: 0.15,
    metalness: 0,
  });
  const lamp = new THREE.MeshStandardMaterial({
    color: BRAND,
    emissive: BRAND,
    emissiveIntensity: 0.6,
  });
  const { width: w, depth: d, height: h } = KIOSK;
  const plinth = new THREE.BoxGeometry(w + 0.3, 0.16, d + 0.3);
  const body = new THREE.BoxGeometry(w, h - 0.36, d);
  const face = new THREE.PlaneGeometry(w - 0.16, h - 0.68);
  const cap = new THREE.CylinderGeometry(0.09, 0.09, 0.2, 20);
  for (const p of spots) {
    const k = new THREE.Group();
    // The point is where the player stands, in front of the kiosk.
    k.position.set(p.x - Math.sin(p.yaw) * 1.2, SLAB_Y, p.z - Math.cos(p.yaw) * 1.2);
    k.rotation.y = p.yaw;
    const base = new THREE.Mesh(plinth, stone);
    base.position.y = 0.08;
    const slab = new THREE.Mesh(body, metal);
    slab.position.y = 0.16 + (h - 0.36) / 2;
    slab.castShadow = true;
    for (const side of [1, -1]) {
      const s = new THREE.Mesh(face, glass);
      s.position.set(0, 0.16 + (h - 0.36) / 2 + 0.02, (side * d) / 2 + side * 0.003);
      if (side < 0) s.rotation.y = Math.PI;
      k.add(s);
    }
    const top = new THREE.Mesh(cap, lamp);
    top.position.y = h - 0.1;
    k.add(base, slab, top);
    group.add(k);
  }
  return {
    group,
    update(night: number) {
      glass.emissiveIntensity = 0.45 + night * 0.6;
      lamp.emissiveIntensity = 0.6 + night * 1.4;
    },
  };
}
