import { type Gear, NO_GEAR } from '@fr33world/shared';
/**
 * The character creation screen's live preview: the character standing in a soft studio
 * light, idling, turned by dragging (or slowly on its own). Its own small renderer, loaded
 * only when the screen opens.
 */
import type { Appearance } from '@fr33world/shared';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { initTextures } from '../assets.ts';
import { Character } from './character.ts';

export class CharacterPreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private readonly turntable = new THREE.Group();
  private character: Character | null = null;
  /** Which request is the latest (a slow load mustn't replace a newer one). */
  private wanted = 0;
  private yaw = 0.35;
  private dragging: { x: number; yaw: number } | null = null;
  private lastInput = 0;
  private frame = 0;
  private last = performance.now();

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    initTextures(this.renderer);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(2, 4, 3);
    const rim = new THREE.DirectionalLight(0xbfe0ff, 1.4);
    rim.position.set(-3, 3, -2);
    this.scene.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x445566, 0.6), this.turntable);
    // A soft round shadow to stand on.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
    );
    disc.position.y = 0.002;
    this.scene.add(disc);
    this.camera.position.set(0, 1.05, 4.1);
    this.camera.lookAt(0, 0.92, 0);

    canvas.addEventListener('pointerdown', this.down);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    this.loop();
  }

  /** Shows `look` (loading it if need be); the previous one stays until it's ready. */
  async show(look: Appearance, gear: Gear = NO_GEAR): Promise<void> {
    const ticket = ++this.wanted;
    const next = await Character.load(look, 0, 0, gear);
    if (ticket !== this.wanted) return;
    if (this.character) this.turntable.remove(this.character.root);
    this.character = next;
    this.turntable.add(next.root);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener('pointerdown', this.down);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    this.renderer.dispose();
  }

  private readonly down = (e: PointerEvent) => {
    this.dragging = { x: e.clientX, yaw: this.yaw };
  };
  private readonly move = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.yaw = this.dragging.yaw + (e.clientX - this.dragging.x) * 0.012;
    this.lastInput = performance.now();
  };
  private readonly up = () => {
    this.dragging = null;
  };

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    // Turns slowly by itself unless someone has turned it lately.
    if (!this.dragging && now - this.lastInput > 3000) this.yaw += dt * 0.35;
    this.turntable.rotation.y = this.yaw;
    this.character?.update(dt, 0);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (
      w > 0 &&
      h > 0 &&
      (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio()) ||
        this.camera.aspect !== w / h)
    ) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  };
}
