/**
 * Materials: photoscanned CC0 surfaces (assets/registry.yaml) and the building facade shader.
 *
 * Facades are one material per wall type. Windows are drawn procedurally in the shader from
 * each wall's world position (bays and floors), so a whole skyline is a handful of draw calls:
 * reflective glass with rooms behind it (interior mapping, Medium and up) by day, and a random pattern of lit rooms at
 * night that differs per building.
 */
import * as THREE from 'three';
import { ktx2Loader } from './assets.ts';
import type { Quality } from './quality.ts';

const BASE = '/assets/textures/';

/**
 * Transparent double-sided materials draw once, every one of them. Left to itself three.js draws
 * each twice, back faces then front, and flips the material's shader for both: car glass, eyelashes
 * and markers went back through its shader lookup about twenty times in every frame.
 */
Object.defineProperty(THREE.Material.prototype, 'forceSinglePass', {
  get: () => true,
  set: () => {},
});

export class Textures {
  private readonly loader = new THREE.TextureLoader();
  private readonly cache = new Map<string, THREE.Texture>();
  private readonly loads = new Map<string, Promise<THREE.Texture>>();
  private readonly anisotropy: number;
  private readonly pending: Promise<unknown>[] = [];
  private decoded = 0;

  constructor(quality: Quality) {
    this.anisotropy = quality.anisotropy;
  }

  /** `repeat`: a texture with its own tiling, sharing the same pixels on the GPU. */
  get(file: string, color: boolean, repeat?: [number, number]): THREE.Texture {
    const key = repeat ? `${file} ${repeat.join()}` : file;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const tex = new THREE.Texture();
    this.pending.push(this.fill(tex, file).then(() => (this.decoded += 1)));
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.anisotropy;
    tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (repeat) tex.repeat.set(...repeat);
    this.cache.set(key, tex);
    return tex;
  }

  /**
   * Fills `tex` (materials already hold it) with the loaded file. Stops waiting after 20 s, so a
   * stuck or missing texture never holds up the loading screen; a late one still appears.
   */
  private async fill(tex: THREE.Texture, file: string): Promise<void> {
    const filled = this.load(file).then((t) => {
      Object.assign(tex, {
        isCompressedTexture: 'isCompressedTexture' in t,
        isDataTexture: 'isDataTexture' in t,
        source: t.source,
        mipmaps: t.mipmaps,
        format: t.format,
        type: t.type,
        flipY: t.flipY,
        generateMipmaps: t.generateMipmaps,
        minFilter: t.minFilter,
        magFilter: t.magFilter,
        unpackAlignment: t.unpackAlignment,
      });
      tex.needsUpdate = true;
    });
    await Promise.race([
      filled.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
  }

  /**
   * The KTX2 version, which stays compressed on the GPU (scripts/assets/city-ktx2.mjs; stored
   * flipped, so it samples as the WebP did), or the WebP if that can't be had.
   */
  private load(file: string): Promise<THREE.Texture> {
    let load = this.loads.get(file);
    if (!load) {
      const webp = `${BASE}${file}`;
      const ktx2 = ktx2Loader()?.loadAsync(webp.replace(/\.webp$/, '.ktx2'));
      load = ktx2 ? ktx2.catch(() => this.loader.loadAsync(webp)) : this.loader.loadAsync(webp);
      this.loads.set(file, load);
    }
    return load;
  }

  /** How many of the textures requested so far have decoded (for the loading screen). */
  progress(): { done: number; total: number } {
    return { done: this.decoded, total: this.pending.length };
  }

  /** Resolves once every texture requested so far has decoded (for loading progress). */
  ready(): Promise<unknown> {
    return Promise.all(this.pending);
  }
}

export interface SurfaceSet {
  color: THREE.Texture;
  normal?: THREE.Texture;
  rough?: THREE.Texture;
}

export function surfaceSet(
  textures: Textures,
  name: string,
  maps = { normal: true, rough: true },
): SurfaceSet {
  return {
    color: textures.get(`${name}_color.webp`, true),
    normal: maps.normal ? textures.get(`${name}_normal.webp`, false) : undefined,
    rough: maps.rough ? textures.get(`${name}_rough.webp`, false) : undefined,
  };
}

/** A ground surface whose geometry carries world-space UVs (1 UV unit = `tile` metres). */
export function surfaceMaterial(
  set: SurfaceSet,
  /**
   * `matte`: ignore the roughness map (grass glared white under a low sun). `overlay`: a
   * surface lying millimetres over another (lawn on a sidewalk slab); drawn with that much
   * depth bias so the two don't flicker against each other at a distance.
   */
  opts: {
    tint?: number;
    roughness?: number;
    normalScale?: number;
    matte?: boolean;
    overlay?: number;
  } = {},
) {
  return new THREE.MeshStandardMaterial({
    polygonOffset: opts.overlay !== undefined,
    polygonOffsetFactor: -(opts.overlay ?? 0),
    polygonOffsetUnits: -(opts.overlay ?? 0),
    map: set.color,
    normalMap: set.normal ?? null,
    normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
    roughnessMap: opts.matte ? null : (set.rough ?? null),
    roughness: opts.roughness ?? 1,
    color: opts.tint ?? 0xffffff,
    metalness: 0,
  });
}

/** Shared uniforms every night-aware material reads. */
export const worldUniforms = {
  uNight: { value: 0 },
};

export type FacadeKind = 'glass' | 'tiles' | 'stucco' | 'brick' | 'cladding';

interface FacadeParams {
  /** Metres of wall per texture repeat. */
  texScale: number;
  /** 0 = punched windows in a wall, 1 = full curtain wall of glass with mullions. */
  curtain: number;
  /** Window size within its bay/floor cell (fractions). */
  winW: number;
  winH: number;
  glass: THREE.Color;
  roughness: number;
}

const FACADES: Record<FacadeKind, FacadeParams> = {
  glass: {
    texScale: 6,
    curtain: 1,
    winW: 0.94,
    winH: 0.78,
    glass: new THREE.Color(0x1f3442),
    roughness: 0.6,
  },
  tiles: {
    texScale: 3,
    curtain: 0,
    winW: 0.6,
    winH: 0.58,
    glass: new THREE.Color(0x1b2329),
    roughness: 0.85,
  },
  stucco: {
    texScale: 2.5,
    curtain: 0,
    winW: 0.55,
    winH: 0.5,
    glass: new THREE.Color(0x1d2226),
    roughness: 0.95,
  },
  brick: {
    texScale: 2.2,
    curtain: 0,
    winW: 0.5,
    winH: 0.55,
    glass: new THREE.Color(0x1a1f23),
    roughness: 0.9,
  },
  cladding: {
    texScale: 3,
    curtain: 0,
    winW: 0.3,
    winH: 0.25,
    glass: new THREE.Color(0x1d2226),
    roughness: 0.8,
  },
};

/**
 * Facade material. Geometry must carry `aBld` (seed, floor height, base y, bay width) and
 * `aTint` (wall colour). Roof faces (normal pointing up) get no windows.
 */
export function facadeMaterial(
  kind: FacadeKind,
  set: SurfaceSet,
  quality: Quality,
): THREE.MeshStandardMaterial {
  const p = FACADES[kind];
  // Rooms behind the windows: too much per pixel for the low tier.
  const interiors = quality.tier !== 'low';
  const material = new THREE.MeshStandardMaterial({
    map: set.color,
    normalMap: quality.facadeNormals ? (set.normal ?? null) : null,
    roughnessMap: set.rough ?? null,
    roughness: p.roughness,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.uniforms.uGlass = { value: p.glass };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aBld;
        attribute vec3 aTint;
        varying vec3 vFacadePos;
        varying vec3 vFacadeN;
        varying vec4 vBld;
        varying vec3 vTint;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vFacadePos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vFacadeN = normalize(mat3(modelMatrix) * objectNormal);
        vBld = aBld;
        vTint = aTint;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform vec3 uGlass;
        varying vec3 vFacadePos;
        varying vec3 vFacadeN;
        varying vec4 vBld;
        varying vec3 vTint;
        const float CURTAIN = ${p.curtain.toFixed(1)};
        ${interiors ? '#define FACADE_INTERIOR' : ''}
        ${kind === 'cladding' ? '#define FACADE_SHED' : ''}
        float fHash(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.x + p.y) * p.z);
        }
        // Curtain-wall design per building: < 0.45 grid (thin mullions, glass spandrels),
        // < 0.75 ribbon windows between stone bands, else deep vertical fins.
        float curtainVariant() { return fHash(vec3(vBld.x, 2.0, 7.0)); }
        // Curtain-wall glass per building, linear: blue, bronze, sea green, charcoal, silver.
        vec3 curtainGlass() {
          float k = fHash(vec3(vBld.x, 4.0, 1.0));
          if (k < 0.3) return vec3(0.013, 0.034, 0.054);
          if (k < 0.48) return vec3(0.05, 0.032, 0.016);
          if (k < 0.66) return vec3(0.026, 0.05, 0.046);
          if (k < 0.84) return vec3(0.016, 0.018, 0.022);
          return vec3(0.06, 0.068, 0.075);
        }
        // Interior mapping (Medium and up): a room behind each window, traced from the camera
        // through the glass: back wall, side walls, floor and ceiling, a piece of furniture, a
        // ceiling light. Returns its colour (linear) and, in \`lamp\`, how much is ceiling light.
        vec3 interiorRoom(vec2 cellF, vec2 cellId, vec3 viewDir, vec3 n, out float lamp) {
          vec3 t = abs(n.x) > abs(n.z) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
          float w = vBld.w;
          float h = vBld.y;
          vec3 dir = vec3(dot(viewDir, t) / w, viewDir.y / h, max(0.05, dot(viewDir, -n)) / (w * 0.9));
          vec3 pos = vec3(cellF, 0.0);
          float tx = dir.x > 0.0 ? (1.0 - pos.x) / dir.x : -pos.x / min(dir.x, -1e-4);
          float ty = dir.y > 0.0 ? (1.0 - pos.y) / dir.y : -pos.y / min(dir.y, -1e-4);
          float tz = 1.0 / dir.z;
          float th = min(min(tx, ty), tz);
          vec3 hit = pos + dir * th;
          float room = fHash(vec3(cellId, vBld.x + 21.0));
          vec3 paint = room < 0.3 ? vec3(0.32, 0.28, 0.22) : (room < 0.6 ? vec3(0.3, 0.3, 0.29) : (room < 0.8 ? vec3(0.2, 0.24, 0.27) : vec3(0.28, 0.22, 0.2)));
          vec3 col;
          lamp = 0.0;
          if (th == tz) {
            col = paint;
            // A sofa, a desk or shelves against the back wall.
            float kind = fHash(vec3(cellId * 1.7, vBld.x + 5.0));
            float lo = step(hit.y, kind < 0.5 ? 0.32 : 0.55) * step(0.18, hit.x) * step(hit.x, 0.82);
            col = mix(col, vec3(0.06, 0.05, 0.05) + 0.08 * vec3(kind, 0.5, 1.0 - kind), lo);
            // A picture or a window to the next room, sometimes.
            float pic = step(0.6, kind) * step(0.4, hit.x) * step(hit.x, 0.62) * step(0.55, hit.y) * step(hit.y, 0.78);
            col = mix(col, vec3(0.5, 0.42, 0.3), pic * 0.7);
          } else if (th == ty) {
            // The floor (wood or carpet) below, the ceiling above with its light.
            col = dir.y < 0.0 ? mix(vec3(0.12, 0.08, 0.05), vec3(0.15, 0.15, 0.16), step(0.5, room)) : vec3(0.42, 0.42, 0.4);
            if (dir.y > 0.0) {
              vec2 c = hit.xz - vec2(0.5);
              lamp = smoothstep(0.22, 0.0, length(c * vec2(1.0, 1.6)));
            }
          } else {
            col = paint * 0.82;
          }
          // Deeper is darker; the corners darkest.
          col *= mix(1.0, 0.45, hit.z);
          return col;
        }

        // Window mask, cell id and in-cell position for the current fragment; \`mull\`: the
        // vertical members between curtain-wall panes.
        float facadeWindow(out vec2 cellId, out vec2 cellF, out vec2 wallUv, out float roof, out float mull) {
          vec3 n = normalize(vFacadeN);
          roof = step(0.5, n.y);
          float u = abs(n.x) > abs(n.z) ? vFacadePos.z : vFacadePos.x;
          float h = vFacadePos.y - vBld.z;
          // Roofs take world xz (height is constant across a roof, which smeared the texture).
          wallUv = mix(vec2(u, h), vFacadePos.xz, roof) / ${p.texScale.toFixed(2)};
          vec2 cell = vec2(u / vBld.w, h / vBld.y);
          cellId = floor(cell);
          cellF = fract(cell);
          float mx = (1.0 - ${p.winW.toFixed(3)}) * 0.5;
          float my = (1.0 - ${p.winH.toFixed(3)});
          // Ground floor: wide shopfront glass on punched walls.
          #ifndef FACADE_SHED
          if (CURTAIN < 0.5 && cellId.y < 0.5) { mx = 0.06; my = 0.28; }
          #endif
          float w = step(mx, cellF.x) * step(cellF.x, 1.0 - mx) * step(my * 0.6, cellF.y) * step(cellF.y, 1.0 - my * 0.4);
          #ifdef FACADE_SHED
          // Warehouses: no glass at street level (loading doors there instead).
          if (cellId.y < 0.5) w = 0.0;
          #endif
          mull = 0.0;
          if (CURTAIN > 0.5) {
            float v = curtainVariant();
            float mw = v < 0.75 ? 0.022 : 0.1;
            float s0 = v < 0.45 ? 0.12 : (v < 0.75 ? 0.34 : 0.07);
            // Anti-aliased: mullions a few cm wide fall under a pixel and shimmered as dashes.
            vec2 aa = fwidth(cellF);
            float inX = smoothstep(mw - aa.x, mw + aa.x, cellF.x) * smoothstep(mw - aa.x, mw + aa.x, 1.0 - cellF.x);
            float inY = smoothstep(s0 - aa.y, s0 + aa.y, cellF.y);
            w = inX * inY;
            mull = (1.0 - inX) * inY;
          }
          float wallFace = (1.0 - roof) * step(0.4, h);
          w *= wallFace;
          mull *= wallFace;
          return w;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 fCell; vec2 fF; vec2 fUv; float fRoof; float fMull;
        float fWin = facadeWindow(fCell, fF, fUv, fRoof, fMull);
        float fVar = curtainVariant();
        vec4 wallTex = texture2D(map, fUv);
        // Weathering: each floor band and each building a little different.
        float floorShade = 0.92 + 0.12 * fHash(vec3(fCell.y, vBld.x, 5.0));
        vec3 wall = wallTex.rgb * vTint * floorShade;
        // Roofs per building: dark tar, warm gravel or a white membrane (LA's cool roofs).
        float roofKind = fHash(vec3(vBld.x, 6.0, 2.0));
        vec3 roofCol = roofKind < 0.35 ? vec3(0.07, 0.07, 0.075) : (roofKind < 0.72 ? vec3(0.17, 0.15, 0.13) : vec3(0.4, 0.4, 0.38));
        wall = mix(wall, roofCol * (0.7 + 0.6 * wallTex.r), fRoof);
        float fRnd = fHash(vec3(fCell, vBld.x));
        // Frames and sills around punched windows; aluminium mullions on curtain walls.
        float mx = (1.0 - ${p.winW.toFixed(3)}) * 0.5;
        float my = 1.0 - ${p.winH.toFixed(3)};
        #ifndef FACADE_SHED
        if (CURTAIN < 0.5 && fCell.y < 0.5) { mx = 0.06; my = 0.28; }
        #endif
        float y0 = my * 0.6;
        float y1 = 1.0 - my * 0.4;
        float fr = 0.035;
        float outer = step(mx - fr, fF.x) * step(fF.x, 1.0 - mx + fr) * step(y0 - fr, fF.y) * step(fF.y, y1 + fr);
        float sill = step(mx - 0.06, fF.x) * step(fF.x, 1.0 - mx + 0.06) * step(y0 - 0.07, fF.y) * step(fF.y, y0 - fr);
        float frame = CURTAIN > 0.5 ? fMull : max(outer - fWin, 0.0);
        frame *= (1.0 - fRoof);
        #ifdef FACADE_SHED
          // No windows at street level, so no frames or sills there either.
          frame *= step(0.5, fCell.y);
        #endif
        sill *= (1.0 - fRoof) * step(0.5, fCell.y) * (1.0 - CURTAIN);
        // Grid curtain walls: the band at each floor slab is opaque dark glass, not stone.
        float spandrel = CURTAIN * step(fVar, 0.45) * (1.0 - fWin) * (1.0 - fMull) * (1.0 - fRoof);
        // Recess shadow just inside the frame, so glass sits back from the wall.
        vec2 edge = min(fF - vec2(mx, y0), vec2(1.0 - mx, y1) - fF);
        float depthShade = 0.45 + 0.55 * smoothstep(0.0, 0.12, min(edge.x * 1.5, edge.y));
        // Glass: tinted, a share of windows show blinds or curtains by day (few, and behind
        // the glass, on curtain walls: bright panes made towers look like pixel art).
        vec3 glassBase = CURTAIN > 0.5 ? curtainGlass() : uGlass;
        vec3 glass = glassBase * (0.85 + 0.3 * fRnd);
        float blinds = step(CURTAIN > 0.5 ? 0.95 : 0.84, fHash(vec3(fCell * 0.71, vBld.x + 3.0)));
        float fLamp = 0.0;
        vec3 fRoom = vec3(0.0);
        #ifdef FACADE_INTERIOR
          // The room behind the glass shows through it by day, faintly on tinted curtain walls.
          // Only where there's glass: walls and roofs skip the trace. Far off, a window is a few
          // pixels and the trace melts into the average room, which costs nothing.
          if (fWin > 0.0) {
            fRoom = vec3(0.145, 0.136, 0.126);
            float roomNear = 1.0 - smoothstep(140.0, 220.0, distance(vFacadePos, cameraPosition));
            if (roomNear > 0.0) {
              float lamp;
              vec3 room = interiorRoom(fF, fCell, normalize(vFacadePos - cameraPosition), normalize(vFacadeN), lamp);
              fRoom = mix(fRoom, room, roomNear);
              fLamp = lamp * roomNear;
            }
            glass = mix(glass, fRoom * (0.35 + 0.25 * (1.0 - uNight)), (CURTAIN > 0.5 ? 0.3 : 0.55) * (1.0 - blinds));
          }
        #endif
        glass = mix(glass, vec3(0.2, 0.19, 0.17) * (0.7 + 0.3 * fRnd), blinds * (CURTAIN > 0.5 ? 0.3 : 0.6));
        glass *= CURTAIN > 0.5 ? 1.0 : depthShade;
        vec3 frameCol = mix(vec3(0.78, 0.78, 0.76), vec3(0.2, 0.21, 0.22), step(0.6, fHash(vec3(vBld.x, 1.0, 9.0))));
        // Fins are part of the wall, in its colour.
        if (CURTAIN > 0.5 && fVar >= 0.75) frameCol = wall * 1.05;
        float fDoor = 0.0;
        float fDoorLamp = 0.0;
        #ifdef FACADE_SHED
          // Corrugated metal: vertical ribs every 25 cm.
          float ribU = abs(vFacadeN.x) > abs(vFacadeN.z) ? vFacadePos.z : vFacadePos.x;
          wall *= mix(1.0, 0.86 + 0.14 * (0.5 + 0.5 * sin(ribU * 25.13)), 1.0 - fRoof);
          // Roll-up loading doors in some street-level bays: steel slats, a hazard kerb, a lamp.
          if (fCell.y < 0.5 && fRoof < 0.5 && fHash(vec3(fCell.x, vBld.x, 13.0)) < 0.45) {
            fDoor = step(0.12, fF.x) * step(fF.x, 0.88) * step(0.03, fF.y) * step(fF.y, 0.8);
            float slat = 0.5 + 0.5 * sin((vFacadePos.y - vBld.z) * 52.0);
            // Painted steel in a building's colour: dark blue-grey, rust brown or green.
            float paintK = fHash(vec3(vBld.x, 3.0, 3.0));
            vec3 steel = paintK < 0.45 ? vec3(0.1, 0.12, 0.15) : (paintK < 0.75 ? vec3(0.17, 0.09, 0.05) : vec3(0.07, 0.13, 0.09));
            vec3 doorCol = steel * (0.8 + 0.2 * slat);
            float kerb = step(0.12, fF.x) * step(fF.x, 0.88) * step(fF.y, 0.03);
            float hazard = step(0.5, fract((fF.x * vBld.w + fF.y * vBld.y) * 1.5));
            wall = mix(wall, mix(vec3(0.05), vec3(0.6, 0.45, 0.05), hazard), kerb);
            wall = mix(wall, doorCol, fDoor);
            // The lamp: a small box over the door's middle.
            fDoorLamp = step(0.46, fF.x) * step(fF.x, 0.54) * step(0.84, fF.y) * step(fF.y, 0.87);
            wall = mix(wall, vec3(0.8, 0.78, 0.7), fDoorLamp);
          }
        #endif
        vec3 surface = mix(wall, glass, fWin);
        surface = mix(surface, glassBase * 0.7, spandrel);
        surface = mix(surface, frameCol, frame);
        surface = mix(surface, wall * 1.25, sill);
        diffuseColor.rgb *= surface;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          roughnessFactor *= texture2D(roughnessMap, fUv).g;
        #endif
        roughnessFactor = mix(roughnessFactor, mix(0.06 + 0.08 * fRnd, 0.6, blinds), fWin);
        roughnessFactor = mix(roughnessFactor, 0.45, frame);
        roughnessFactor = mix(roughnessFactor, 0.2, spandrel);
        // Matte roofs.
        roughnessFactor = mix(roughnessFactor, 0.97, fRoof);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = mix(metalness, mix(0.7, 0.1, blinds), fWin);
        metalnessFactor = mix(metalnessFactor, 0.6, frame);
        metalnessFactor = mix(metalnessFactor, 0.6, spandrel);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D(normalMap, fUv).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale * (1.0 - fWin);
          mat3 fTbn = getTangentFrame(-vViewPosition, normal, fUv);
          normal = normalize(fTbn * mapN);
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Night: a building-specific share of rooms is lit, in warm and cool whites.
        float occupancy = 0.06 + 0.26 * fHash(vec3(vBld.x, 7.0, 3.0));
        float lit = step(1.0 - occupancy, fHash(vec3(fCell * 1.37, vBld.x + 11.0)));
        vec3 roomLight = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.7, fRnd));
        #ifdef FACADE_SHED
          // Loading-door lamps at night, and their pool on the door.
          totalEmissiveRadiance += vec3(1.0, 0.85, 0.6) * uNight * (fDoorLamp * 2.5 + fDoor * 0.08 * smoothstep(0.45, 0.8, fF.y));
        #endif
        #ifdef FACADE_INTERIOR
          // Lit rooms show what's in them: their walls lit warm or cool, brightest at the lamp.
          vec3 inside = roomLight * (fRoom * 2.2 + fLamp * 0.9 + 0.08);
          totalEmissiveRadiance += mix(roomLight, inside, 1.0 - blinds) * lit * fWin * uNight * (0.45 + 0.55 * fRnd);
        #else
          totalEmissiveRadiance += roomLight * lit * fWin * uNight * (0.35 + 0.65 * fRnd) * depthShade;
        #endif`,
      );
  };
  material.customProgramCacheKey = () =>
    `facade-${kind}-${quality.facadeNormals ? 'n' : ''}${interiors ? 'i' : ''}`;
  return material;
}
