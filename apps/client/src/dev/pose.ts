/**
 * Dev only (pose.html, not in the build): one character in one moment of a clip, on a clear
 * background, for the interface's pictures (scripts/assets/ui-pictures.mjs: the emotes menu,
 * the tutorial's Luz). ?look=f.5.9.0 (as rbtest) &clip=waving &sec=1.2 (into the clip)
 * &view=full|bust &turn=0.35 &follow (the camera on the hips). Or one car from the front three-quarters, for the dealership:
 * ?car=coupe, with its driver: &driver=drive|enter|exit &sec (into the move) &look.
 */
import { type Appearance, CAR_MODELS, DEFAULT_APPEARANCE } from '@fr33world/shared';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { initTextures } from '../game/assets.ts';
import { Character } from '../game/character/character.ts';
import { CarBatch } from '../game/vehicles/car-model.ts';
import { seatCharacter } from '../game/vehicles/seating.ts';

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
const [body, ...rest] = (params.get('look') ?? 'm.0.0').split('.');
const look: Appearance = { ...DEFAULT_APPEARANCE, body: body === 'f' ? 'female' : 'male' };
rest.forEach((v, i) => Object.assign(look, { [FIELDS[i] ?? '']: Number(v) }));
const clip = params.get('clip');
const sec = Number(params.get('sec') ?? 1);
const bust = params.get('view') === 'bust';
const turn = Number(params.get('turn') ?? 0.35);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
initTextures(renderer);
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
key.position.set(2, 4, 3);
const rim = new THREE.DirectionalLight(0xbfe0ff, 1.4);
rim.position.set(-3, 2, -2);
scene.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x445566, 0.6));
const camera = new THREE.PerspectiveCamera(
  bust ? 22 : 30,
  canvas.clientWidth / canvas.clientHeight,
  0.1,
  50,
);
if (bust) {
  camera.position.set(0, 1.42, 2.6);
  camera.lookAt(0, 1.3, 0);
} else {
  camera.position.set(0, 1.0, 4.4);
  camera.lookAt(0, 0.92, 0);
}

const carId = params.get('car');
if (carId) {
  // Framed to the car's size: the whole car, a little from above, nose to the left.
  const model = Math.max(
    0,
    CAR_MODELS.findIndex((m) => m.id === carId),
  );
  const spec = CAR_MODELS[model] as (typeof CAR_MODELS)[number];
  const batch = new CarBatch(scene, model, 1);
  await batch.ready;
  const body = new THREE.Matrix4().makeRotationY(-0.62);
  batch.begin();
  batch.add(
    body,
    0,
    0,
    spec.wheels.map(([x, y, z]) =>
      body.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z)),
    ),
  );
  batch.end();
  const phase = params.get('driver') as 'drive' | 'enter' | 'exit' | null;
  const anim = phase && (await Character.load(look, 0));
  if (anim?.animator) {
    scene.add(anim.root);
    const a = anim.animator;
    if (phase === 'enter') await a.getIn();
    else if (phase === 'exit') await a.getOut();
    else await a.drive();
    for (let t = 0; t < (params.has('sec') ? sec : 1); t += 1 / 30) anim.update(1 / 30, 0);
    const seatAs = a.seat ?? phase;
    seatCharacter(
      anim.root,
      { pos: new THREE.Vector3(), yaw: -0.62, id: spec.id },
      seatAs === 'enter' ? 'enter' : seatAs === 'exit' ? 'exit' : 'drive',
      a.hipsRestY,
    );
  }
  camera.fov = 26;
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  const reach = Math.max(spec.length, spec.width * 2) * 1.9;
  camera.position.set(0, spec.height * 1.25 + 0.6, reach);
  camera.lookAt(0, spec.height * 0.45, 0);
  camera.updateProjectionMatrix();
} else {
  const c = await Character.load(look, 0);
  c.root.rotation.y = turn;
  scene.add(c.root);
  if (clip) await c.animator?.play(clip, true);
  // &aim=pistol|rifle &pitch=0.5: aiming that way (the spine's bend).
  const aim = params.get('aim');
  if (aim && c.animator) {
    c.animator.setStance(aim === 'rifle' ? 'rifle' : 'pistol');
    for (let t = 0; t < 1.5; t += 1 / 30) c.update(1 / 30, 0);
    c.animator.setAiming(true);
    c.animator.pitch = Number(params.get('pitch') ?? 0);
  }
  // &care=bandaging|medicine: patching up (with &sec into it).
  const care = params.get('care');
  if (care === 'bandaging' || care === 'medicine') {
    for (let t = 0; t < 0.5; t += 1 / 30) c.update(1 / 30, 0);
    await c.patchUp(care);
  }
  // Into the clip: small steps, as the game advances it.
  for (let t = 0; t < sec; t += 1 / 30) c.update(1 / 30, 0);
  // Where the hips are and which way the body faces (from the shoulders), for measuring clips:
  // window.__hips = { x, y, z, yaw }.
  const bone = (n: string) => c.root.getObjectByName(`mixamorig${n}`) ?? c.root.getObjectByName(n);
  const at = new THREE.Vector3();
  bone('Hips')?.getWorldPosition(at);
  const l = new THREE.Vector3();
  const r = new THREE.Vector3();
  bone('LeftArm')?.getWorldPosition(l);
  bone('RightArm')?.getWorldPosition(r);
  const left = l.sub(r);
  (window as Window & { __hips?: object }).__hips = {
    x: at.x,
    y: at.y,
    z: at.z,
    // Forward is left × up; yaw 0 faces +z.
    yaw: Math.atan2(-left.z, left.x),
  };
  // &follow: keep the hips in the middle (clips that travel, like getting into a car).
  if (params.has('follow')) {
    camera.position.x += at.x;
    camera.position.z += at.z;
    camera.lookAt(at.x, 0.92, at.z);
  }
}
renderer.render(scene, camera);
document.body.dataset.ready = '1';
