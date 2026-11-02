/**
 * Traffic signals and street-name signs at the junctions (junctions.ts). Signals: a galvanised
 * pole on the corner with a mast arm over the approach's lanes and a dark signal head above
 * each lane, its three lenses facing the oncoming traffic. The lenses change in a shader from
 * one shared clock (the real time, so every player sees the same lights): north–south green,
 * amber, all red, then east–west, each junction shifted for a green wave. No per-light work on
 * the CPU. Street-name signs: green blades with white names (one canvas atlas, painted at
 * start-up), one along each street, at the top of a post or the signal pole.
 */
import * as THREE from 'three';
import type { CityLayout } from '@fr33world/city';
import type { Tier } from '../quality.ts';
import { GeoBuilder } from './geo.ts';
import { type Junction, junctions, type Leg, POLE_HEIGHT, SIGN_POST_HEIGHT } from './junctions.ts';
import { TiledGeo } from './tiles.ts';

const SLAB_Y = 0.15;
/** The signal cycle (s): north–south green, amber, all red, then east–west the same. */
const CYCLE = 40;
const GREEN = 16;
const AMBER = 3;
/** How far signals and signs are drawn per tier (m). */
const DISTANCE: Record<Tier, number> = { low: 200, medium: 300, high: 400, ultra: 550 };

type V = { x: number; y: number; z: number };

/**
 * A vertical rectangle centred on (cx, cy, cz), `w` wide and `h` tall, facing `face` (a unit
 * axis direction), with texture coordinates u0–u1 left to right as seen from the front.
 */
function panel(
  g: GeoBuilder,
  c: V,
  w: number,
  h: number,
  face: [number, number],
  uv: [number, number, number, number] = [0, 0, 1, 1],
) {
  const [fx, fz] = face;
  // Seen from the front (looking along -face, y up), "right" is (fz, -fx).
  const [rx, rz] = [fz, -fx];
  const corner = (s: number, t: number) => ({
    x: c.x + rx * s * (w / 2) + fx * 0.001,
    y: c.y + t * (h / 2),
    z: c.z + rz * s * (w / 2) + fz * 0.001,
  });
  const [u0, v0, u1, v1] = uv;
  g.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), { x: fx, y: 0, z: fz }, [
    u0,
    v0,
    u1,
    v0,
    u1,
    v1,
    u0,
    v1,
  ]);
}

/** The direction from the junction towards an approach's traffic. */
const TOWARDS: Record<Leg, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

/** Every street name at a junction, painted once into a canvas (one row each). */
function nameAtlas(names: string[]) {
  const W = 512;
  const H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H * names.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const widths = new Map<string, number>();
  names.forEach((name, i) => {
    const y = i * H;
    ctx.fillStyle = '#1d6b3c';
    ctx.fillRect(0, y, W, H);
    ctx.strokeStyle = '#f2f2ee';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, y + 4, W - 8, H - 8);
    ctx.fillStyle = '#f7f7f2';
    ctx.font = `700 40px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, W / 2, y + H / 2 + 2, W - 24);
    widths.set(name, Math.min(W - 24, ctx.measureText(name).width + 40) / W);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return {
    texture: tex,
    /** The atlas rectangle of a name: its row, cropped to the text's width. */
    uv(name: string): [number, number, number, number] {
      const i = names.indexOf(name);
      const w = widths.get(name) ?? 1;
      const v0 = 1 - (i + 1) / names.length;
      const v1 = 1 - i / names.length;
      return [0.5 - w / 2, v0, 0.5 + w / 2, v1];
    },
    /** Blade length for a name (m): the text's share of a 2.4 m blade. */
    length(name: string) {
      return 2.4 * (widths.get(name) ?? 1);
    },
  };
}

/** The lenses' material: lit or dark from the cycle, per lens (group, colour, offset). */
function lensMaterial(time: { value: number }) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: time },
    vertexShader: /* glsl */ `
      attribute vec3 aSignal;
      uniform float uTime;
      varying vec3 vColor;
      void main() {
        float t = mod(uTime + aSignal.z, ${CYCLE.toFixed(1)});
        // Which lens is lit for this group: 0 red, 1 amber, 2 green.
        float half_ = ${(CYCLE / 2).toFixed(1)};
        float local = aSignal.x < 0.5 ? t : mod(t + half_, ${CYCLE.toFixed(1)});
        float lit = local < ${GREEN.toFixed(1)} ? 2.0 : local < ${(GREEN + AMBER).toFixed(1)} ? 1.0 : 0.0;
        vec3 colour = aSignal.y < 0.5 ? vec3(1.0, 0.12, 0.08)
          : aSignal.y < 1.5 ? vec3(1.0, 0.62, 0.05) : vec3(0.1, 1.0, 0.3);
        vColor = abs(aSignal.y - lit) < 0.5 ? colour * 1.6 : colour * 0.1;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() { gl_FragColor = vec4(vColor, 1.0); }`,
    side: THREE.DoubleSide,
  });
}

export function buildSignals(city: CityLayout, tier: Tier) {
  const all = junctions(city);
  const names = [...new Set(all.flatMap((j) => [j.ns.name, j.ew.name]))].sort();
  const atlas = nameAtlas(names);
  const tiles = new TiledGeo(() => ({
    metal: new GeoBuilder(),
    housing: new GeoBuilder(),
    lenses: new GeoBuilder().attribute('aSignal', 3, [0, 0, 0]),
    blades: new GeoBuilder(),
  }));

  for (const j of all) {
    const t = tiles.at(j.x, j.z);
    for (const s of j.signals) {
      // The pole, and its arm out over the lanes at the top.
      t.metal.box(s.x - 0.13, SLAB_Y, s.z - 0.13, s.x + 0.13, SLAB_Y + POLE_HEIGHT, s.z + 0.13, 1);
      const reach = Math.max(...s.lanes) + 0.8;
      const [ax, az] = s.arm;
      const end = { x: s.x + ax * reach, z: s.z + az * reach };
      const armY = SLAB_Y + POLE_HEIGHT - 0.35;
      t.metal.box(
        Math.min(s.x, end.x) - 0.08,
        armY - 0.08,
        Math.min(s.z, end.z) - 0.08,
        Math.max(s.x, end.x) + 0.08,
        armY + 0.08,
        Math.max(s.z, end.z) + 0.08,
        1,
      );
      const face = TOWARDS[s.from];
      for (const along of s.lanes) {
        const hx = s.x + ax * along;
        const hz = s.z + az * along;
        const [y0, y1] = [armY - 1.15, armY - 0.1];
        t.housing.box(hx - 0.2, y0, hz - 0.2, hx + 0.2, y1, hz + 0.2, 1);
        // Red over amber over green, on the face towards the traffic.
        for (let k = 0; k < 3; k += 1) {
          t.lenses.set('aSignal', [s.group, 2 - k, j.offset]);
          const c = { x: hx + face[0] * 0.21, y: y0 + 0.2 + k * 0.32, z: hz + face[1] * 0.21 };
          panel(t.lenses, c, 0.24, 0.24, face);
        }
      }
    }
    // The street-name sign: a post (unless it's on a signal pole) with a blade along each
    // street, both sides painted.
    const { x, z } = j.sign;
    const top = SLAB_Y + (j.signals.length > 0 ? POLE_HEIGHT - 1.4 : SIGN_POST_HEIGHT);
    if (j.signals.length === 0)
      t.metal.box(x - 0.05, SLAB_Y, z - 0.05, x + 0.05, top + 0.45, z + 0.05, 1);
    for (const [road, along, y] of [
      [j.ns, [0, 1], top + 0.3],
      [j.ew, [1, 0], top],
    ] as const) {
      const len = atlas.length(road.name);
      // Out from the post towards the junction's middle along its street.
      const dx = along[0] * Math.sign(j.x - x || 1);
      const dz = along[1] * Math.sign(j.z - z || 1);
      const c = { x: x + dx * (len / 2), y, z: z + dz * (len / 2) };
      const uv = atlas.uv(road.name);
      const normal: [number, number] = [along[1], along[0]];
      panel(t.blades, c, len, 0.28, normal, uv);
      panel(t.blades, c, len, 0.28, [-normal[0], -normal[1]], uv);
    }
  }

  const time = { value: 0 };
  const lenses = lensMaterial(time);
  const group = tiles.build(
    {
      metal: {
        material: new THREE.MeshStandardMaterial({
          color: 0x8d9298,
          roughness: 0.5,
          metalness: 0.6,
        }),
        name: 'signal-poles',
        cast: true,
      },
      housing: {
        material: new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.6 }),
        name: 'signal-heads',
        cast: true,
      },
      lenses: { material: lenses, name: 'signal-lenses' },
      blades: {
        material: new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.6 }),
        name: 'street-signs',
      },
    },
    DISTANCE[tier],
    'signals',
  );
  return {
    group,
    junctions: all as readonly Junction[],
    /** The shared clock: real seconds (every player's lights agree). */
    update() {
      time.value = (Date.now() / 1000) % 3600;
    },
  };
}
