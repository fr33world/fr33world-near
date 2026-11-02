/**
 * Dev only (rbtest.html, not in the build): game characters side by side, for checking looks.
 * ?looks=m.0.0.0.0,f.3.2.4.0.1.2.3 — each body (m or f) then face, outfit, skin, facialHair, top,
 * bottom, shoes, height, build (missing ones default); &speed=1.6 walks them; &face zooms in on
 * the heads (&at=1.3 at another height); &turn=0.5 turns them; &gun arms them (&aim to aim).
 */
import { type Appearance, DEFAULT_APPEARANCE, type Gear, NO_GEAR } from '@fr33world/shared';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { initTextures } from '../game/assets.ts';
import { Character } from '../game/character/character.ts';
import { heavyPistol } from '../game/combat.ts';

const params = new URLSearchParams(location.search);
const FIELDS = [
  'face',
  'outfit',
  'skin',
  'facialHair',
  'top',
  'bottom',
  'shoes',
  'height',
  'build',
];
const looks = (params.get('looks') ?? 'm.0.0,m.3.4.4.4,f.0.0,f.5.6.2').split(',').map((s) => {
  const [body, ...rest] = s.split('.');
  const look: Appearance = { ...DEFAULT_APPEARANCE, body: body === 'f' ? 'female' : 'male' };
  rest.forEach((v, i) => Object.assign(look, { [FIELDS[i] ?? '']: Number(v) }));
  return look;
});
const speed = Number(params.get('speed') ?? 0);
// &gear=head.eyes.neck.wrist.bag.headColour.bagColour (one for all).
const GEAR_FIELDS: (keyof Gear)[] = [
  'head',
  'eyes',
  'neck',
  'wrist',
  'bag',
  'headColour',
  'bagColour',
];
const gears = (params.get('gear') ?? '').split(',').map((s) => {
  const g: Gear = { ...NO_GEAR };
  s.split('.').forEach((v, i) => v && Object.assign(g, { [GEAR_FIELDS[i] ?? '']: Number(v) }));
  return g;
});
const faceView = params.has('face');
const at = Number(params.get('at') ?? 1.6);
const turn = Number(params.get('turn') ?? 0.4);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
initTextures(renderer);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2f36);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(2, 4, 3);
scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x445566, 0.5));
const gap = faceView ? 0.42 : 1.1;
const width = looks.length * gap;
const camera = new THREE.PerspectiveCamera(
  faceView ? 18 : 32,
  canvas.clientWidth / canvas.clientHeight,
  0.1,
  50,
);
camera.position.set(0, faceView ? at + 0.02 : 1.2, faceView ? Math.max(1.6, width * 1.9) : 7);
camera.lookAt(0, faceView ? at : 0.95, 0);

const characters = await Promise.all(
  looks.map(async (look, i) => {
    const c = await Character.load(look, 0, undefined, gears[i] ?? gears[0] ?? NO_GEAR);
    c.root.position.x = (i - (looks.length - 1) / 2) * gap;
    c.root.rotation.y = turn;
    if (params.has('gun')) {
      const gun = heavyPistol();
      gun.visible = true;
      c.holdInRightHand(gun);
      c.animator?.setStance('pistol');
      c.animator?.setAiming(params.has('aim'));
    }
    scene.add(c.root);
    return c;
  }),
);
document.body.dataset.ready = '1';
const clock = new THREE.Clock();
let jumpIn = 1;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  for (const c of characters) c.update(dt, speed);
  // &jump: jump every 1.2 s.
  jumpIn -= dt;
  if (params.has('jump') && jumpIn <= 0) {
    jumpIn = 1.2;
    for (const c of characters) c.animator?.jump();
  }
  renderer.render(scene, camera);
});
