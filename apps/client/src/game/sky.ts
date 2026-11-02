/**
 * Day and night on the server clock (decision D-18): a physically based sky, the sun and moon
 * as directional lights, hemisphere fill, Los Soles haze as fog, stars, and an environment map
 * re-rendered from the sky now and then so glass and car paint reflect the right time of day.
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { Quality } from './quality.ts';

/** A lower noon sun: softer light and longer shadows than an overhead glare. */
const MAX_ELEVATION = THREE.MathUtils.degToRad(56);
const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
/**
 * Exposure by time of day (owner, 2026-10-28: a cool, soft day, not blinding; nights that
 * stay readable). Night opens up like eyes adjusting to the dark.
 */
const DAY_EXPOSURE = 0.36;
const NIGHT_EXPOSURE = 1.1;
/**
 * How bright the ground should look by day and by night. A low sun only grazes the ground, so
 * at one exposure the streets sank through the afternoon to under a third of noon, then jumped
 * to night (owner, 2026-11-02: too dark); the exposure now rises as the sun sinks to hold them.
 */
const DAY_GROUND = 1.54;
const NIGHT_GROUND = 2.62;
/** How much of the moon reaches the ground, at its low angle. */
const MOON_ON_GROUND = 0.45;

/** Long days (owner, 2026-11-02): the sun is up from 5:00 to 19:00, so 16:00 to 18:30 is light. */
const SUNRISE = 5;
const SUNSET = 19;

/** The sun's way round: 0 at sunrise, π at sunset, on to 2π at the next sunrise. */
export function sunAngle(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= SUNRISE && h <= SUNSET) return (Math.PI * (h - SUNRISE)) / (SUNSET - SUNRISE);
  const night = 24 - (SUNSET - SUNRISE);
  return Math.PI + Math.PI * (((h - SUNSET + 24) % 24) / night);
}

export interface SkyState {
  hour: number;
  /** 0 in daylight, 1 in full night; drives lit windows, street lights and headlights. */
  night: number;
  sunDirection: THREE.Vector3;
}

export class DayNight {
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly moon = new THREE.DirectionalLight(0x9db2e2, 0);
  readonly hemi = new THREE.HemisphereLight(0xbcd4ff, 0x5b4a3a, 1);
  readonly state: SkyState = { hour: 12, night: 0, sunDirection: new THREE.Vector3(0, 1, 0) };

  private readonly sky = new Sky();
  private readonly stars: THREE.Points;
  private readonly nightDome: THREE.Mesh;
  private readonly envScene = new THREE.Scene();
  private readonly envSky = new Sky();
  /** What glass and paint reflect at night: the city's glow on the haze, not a black sky. */
  private readonly envNight = makeNightDome(900, 2.4);
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastEnvAt = -Infinity;
  private lastEnvHour = -100;
  private readonly fog: THREE.FogExp2;
  private readonly scene: THREE.Scene;
  private readonly quality: Quality;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: Quality) {
    this.scene = scene;
    this.quality = quality;
    this.sky.scale.setScalar(quality.viewDistance * 0.9);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky, this.envNight);
    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      // A little haze and a tight, faint sun halo: a cool clear day rather than a glaring one.
      u.turbidity!.value = 4.2;
      u.rayleigh!.value = 2.2;
      u.mieCoefficient!.value = 0.0025;
      u.mieDirectionalG!.value = 0.74;
    }

    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -quality.shadowRadius;
    cam.right = quality.shadowRadius;
    cam.top = quality.shadowRadius;
    cam.bottom = -quality.shadowRadius;
    cam.near = 1;
    cam.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.autoUpdate = false;
    scene.add(this.sun, this.sun.target, this.moon, this.moon.target, this.hemi);

    this.stars = makeStars(quality.viewDistance * 0.8);
    scene.add(this.stars);
    this.nightDome = makeNightDome(quality.viewDistance * 0.85);
    scene.add(this.nightDome);

    this.fog = new THREE.FogExp2(0xc9d3dc, 0.00045);
    scene.fog = this.fog;
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /** Moves sun, moon and colours to `hour`, keeping the shadow box centred on `focus`. */
  /** `eye`: the camera, which the sky, stars and night dome are centred on. */
  update(
    hour: number,
    focus: THREE.Vector3,
    renderer: THREE.WebGLRenderer,
    now: number,
    eye: THREE.Vector3 = focus,
  ): SkyState {
    const azimuth = sunAngle(hour);
    const elevation = MAX_ELEVATION * Math.sin(azimuth);
    const horizontal = Math.cos(elevation);
    const dir = this.state.sunDirection.set(
      Math.cos(azimuth) * horizontal,
      Math.sin(elevation),
      Math.sin(azimuth) * horizontal,
    );
    const elevDeg = THREE.MathUtils.radToDeg(elevation);
    const day = THREE.MathUtils.smoothstep(elevDeg, -6, 8);
    const golden = 1 - THREE.MathUtils.smoothstep(elevDeg, 2, 28);
    const night = 1 - THREE.MathUtils.smoothstep(elevDeg, -10, 2);
    this.state.hour = hour;
    // Windows and street lights come on before the sun has gone, as they do in a real city, and
    // stay on until after it's up: the half hour either side had neither sun nor lamps.
    this.state.night = 1 - THREE.MathUtils.smoothstep(elevDeg, -5, 7);
    // The sky, stars and night dome go where the camera goes: left at the origin, the sky box
    // ended a few hundred metres out and the hills (a kilometre away) saw black past its edge.
    this.sky.position.copy(eye);
    this.stars.position.copy(eye);
    this.nightDome.position.copy(eye);

    for (const s of [this.sky, this.envSky]) {
      (s.material.uniforms.sunPosition as THREE.IUniform<THREE.Vector3>).value.copy(dir);
    }
    this.stars.visible = night > 0.05;
    this.nightDome.visible = night > 0.01;
    (this.nightDome.material as THREE.ShaderMaterial).uniforms.uOpacity!.value = night;
    (this.stars.material as THREE.PointsMaterial).opacity = night * 0.9;

    // Sun: warm and low at golden hour, a cool soft white by day, off below the horizon.
    this.sun.color.setRGB(1, 0.62 + 0.35 * (1 - golden), 0.38 + 0.6 * (1 - golden));
    this.sun.intensity = 3.6 * day;
    // Never hidden, only dimmed: changing how many lights are visible makes three.js rebuild
    // every material's shader, a freeze of seconds on a phone at each dawn and dusk.
    const box = this.snapToTexels(focus, dir);
    this.sun.position.copy(box).addScaledVector(dir, 300);
    this.sun.target.position.copy(box);

    // Moon opposite the sun: a cool, dim key light so night stays readable. Kept low, so it
    // rakes across the walls rather than lighting only the roofs.
    const moonDir = new THREE.Vector3(-dir.x, 0, -dir.z)
      .normalize()
      .multiplyScalar(0.85)
      .setY(Math.min(0.55, Math.max(0.35, -dir.y)))
      .normalize();
    this.moon.intensity = 2.4 * night;
    this.moon.position.copy(focus).addScaledVector(moonDir, 300);
    this.moon.target.position.copy(focus);

    // Sky fill carries more of the daylight than the sun does, which keeps the day cool. At
    // night it stands in for the city's own light: a blue sky above, and warm street light
    // thrown back up off the pavement, so walls read instead of going black.
    // With the sun on the horizon, the sky is all the light there is: it carries the twilight.
    const twilight = 4 * day * (1 - day);
    this.hemi.intensity = 0.55 + 0.75 * day + 0.75 * night + 1.0 * twilight;
    const onGround =
      this.hemi.intensity +
      this.sun.intensity * Math.max(0, dir.y) +
      this.moon.intensity * MOON_ON_GROUND;
    renderer.toneMappingExposure = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(DAY_GROUND, NIGHT_GROUND, night) / onGround,
      DAY_EXPOSURE,
      NIGHT_EXPOSURE,
    );
    this.hemi.color.setRGB(0.5 + 0.22 * day, 0.6 + 0.22 * day, 0.9);
    this.hemi.groundColor.setRGB(
      0.32 * day + 0.06 + 0.3 * night,
      0.26 * day + 0.06 + 0.2 * night,
      0.2 * day + 0.08 + 0.1 * night,
    );

    // Haze: warm and thick near the horizon at golden hour, blue-black at night.
    const fogDay = new THREE.Color(0xaebdcc).lerp(new THREE.Color(0xe0b48c), golden * day);
    this.fog.color.copy(fogDay).lerp(new THREE.Color(0x0c1422), night);
    this.fog.density = 0.00028 + 0.00016 * golden;
    this.scene.background = null;

    if (
      Math.abs(hour - this.lastEnvHour) > 0.08 &&
      now - this.lastEnvAt > this.quality.envUpdateMs
    ) {
      this.renderEnvironment(renderer, night, twilight);
      this.lastEnvAt = now;
      this.lastEnvHour = hour;
    }
    return this.state;
  }

  /**
   * The shadow box's centre: `focus` moved to the nearest whole shadow-map texel across the
   * sun's beam. Following the player smoothly, the map's texels slid over the ground every
   * frame and every shadow edge in view crawled and flickered as they walked (Medium's map is
   * coarse enough to see it plainly).
   */
  private snapToTexels(focus: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
    const texel = (2 * this.quality.shadowRadius) / this.quality.shadowMapSize;
    this.lightBasis.lookAt(dir, ORIGIN, UP);
    this.lightBasis.extractBasis(this.lightX, this.lightY, this.lightZ);
    const u = Math.round(focus.dot(this.lightX) / texel) * texel;
    const v = Math.round(focus.dot(this.lightY) / texel) * texel;
    const w = focus.dot(this.lightZ);
    return this.shadowCentre
      .copy(this.lightX)
      .multiplyScalar(u)
      .addScaledVector(this.lightY, v)
      .addScaledVector(this.lightZ, w);
  }
  private readonly lightBasis = new THREE.Matrix4();
  private readonly lightX = new THREE.Vector3();
  private readonly lightY = new THREE.Vector3();
  private readonly lightZ = new THREE.Vector3();
  private readonly shadowCentre = new THREE.Vector3();

  /** Call when the shadow box should be redrawn this frame. */
  refreshShadows(): void {
    this.sun.shadow.needsUpdate = true;
  }

  private renderEnvironment(renderer: THREE.WebGLRenderer, night: number, twilight: number) {
    this.envSky.visible = night <= 0.6;
    this.envNight.visible = night > 0.6;
    (this.envNight.material as THREE.ShaderMaterial).uniforms.uOpacity!.value = 1;
    const target = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
    this.envTarget?.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
    // A sky with the sun on the horizon has little in it to reflect: it's lifted to make up.
    this.scene.environmentIntensity = (0.45 + 0.35 * (1 - night)) * (1 + 3 * twilight);
  }
}

/**
 * Night sky: deep blue overhead fading to the warm sodium glow a big city throws on its haze
 * at the horizon. Blended over the physical sky by the night factor.
 */
function makeNightDome(radius: number, gain = 1): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uGain: { value: gain } },
    vertexShader: `varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform float uOpacity;
      uniform float uGain;
      varying vec3 vDir;
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 zenith = vec3(0.012, 0.018, 0.04);
        vec3 horizon = vec3(0.16, 0.1, 0.08);
        vec3 col = mix(horizon, zenith, pow(h, 0.35));
        gl_FragColor = vec4(col * uGain, uOpacity);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  dome.frustumCulled = false;
  dome.renderOrder = -2;
  return dome;
}

function makeStars(radius: number): THREE.Points {
  const count = 1500;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const u = Math.random();
    const v = Math.random() * 0.95 + 0.05;
    const theta = u * Math.PI * 2;
    const phi = Math.acos(1 - v);
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * radius;
    positions[i * 3 + 1] = Math.cos(phi) * radius;
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  return stars;
}
