/**
 * Unified input for desktop and touch. Desktop: WASD/arrows, mouse look under pointer lock,
 * Space jump, Shift walk, E/F enter or leave a car. Touch: the HUD's joystick and look pad
 * write into the same fields, so game code never cares which device is in use.
 */
/** One notch of a mouse wheel, as a share of the camera's distance. */
const WHEEL_ZOOM = 0.1;

export class Input {
  /** Movement intent, -1..1: x is right, y is forward. */
  readonly move = { x: 0, y: 0 };
  /** Accumulated look in pixels since the last frame (consumed by the camera). */
  readonly look = { x: 0, y: 0 };
  /** Accumulated zoom since the last frame, as a share of the distance (out is positive). */
  zoom = 0;
  /** Walking instead of running (Shift on desktop, a gentle stick push on touch). */
  walk = false;
  /** Car controls: throttle -1 (brake/reverse)..1, steer -1 (left)..1 (right). */
  readonly drive = { throttle: 0, steer: 0, brake: false, handbrake: false, horn: false };
  /** Held touch pedals, set by the driving HUD. */
  touchGas = false;
  touchBrake = false;
  touchHorn = false;
  /** The touch steering wheel: -1 (full left) … 1 (full right), or null when not held. */
  touchSteer: number | null = null;

  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private stick = { x: 0, y: 0, active: false };
  private readonly canvas: HTMLCanvasElement;
  private readonly cleanup: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(type, fn);
      this.cleanup.push(() => window.removeEventListener(type, fn));
    };
    on('keydown', (e) => {
      // Typing in a text box (chat): the keys are words, not moves.
      if (typing(e.target)) {
        this.keys.clear();
        return;
      }
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    on('keyup', (e) => this.keys.delete(e.code));
    on('blur', () => this.keys.clear());
    // Mouse buttons count as keys ('Mouse0' fire, 'Mouse2' aim) once the pointer is locked.
    on('mousedown', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.keys.add(`Mouse${e.button}`);
      this.pressed.add(`Mouse${e.button}`);
    });
    on('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
    on('contextmenu', (e) => e.preventDefault());
    // Over the game only: the wheel still scrolls the phone, the shop and every other sheet.
    on('wheel', (e) => {
      if (e.target === canvas) this.zoom += Math.sign(e.deltaY) * WHEEL_ZOOM;
    });
    on('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this.look.x += e.movementX;
        this.look.y += e.movementY;
      }
    });
    const lock = () => {
      if (!navigator.maxTouchPoints && document.pointerLockElement !== canvas) {
        void canvas.requestPointerLock?.();
      }
    };
    canvas.addEventListener('click', lock);
    this.cleanup.push(() => canvas.removeEventListener('click', lock));
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
  }

  /** Called by the touch joystick: x right, y forward, both -1..1 (null when released). */
  setStick(x: number, y: number, active: boolean): void {
    this.stick = { x, y, active };
  }

  /** Holds or releases a virtual key from a HUD button (e.g. 'aim' while Fire is held). */
  setHeld(code: string, on: boolean): void {
    if (on) this.keys.add(code);
    else this.keys.delete(code);
  }

  /** Called by the touch look pad's pinch. */
  addZoom(amount: number): void {
    this.zoom += amount;
  }

  addLook(dx: number, dy: number): void {
    this.look.x += dx;
    this.look.y += dy;
  }

  /** A one-shot action from a HUD button (same names as key codes). */
  press(code: string): void {
    this.pressed.add(code);
  }

  /** True once per press of any of `codes` since the last frame. */
  consume(...codes: string[]): boolean {
    let hit = false;
    for (const c of codes) if (this.pressed.delete(c)) hit = true;
    return hit;
  }

  held(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Recomputes `move`, `walk` and `drive` from keys or touch; call once per frame. */
  update(): void {
    const keyThrottle =
      (this.held('KeyW', 'ArrowUp') ? 1 : 0) - (this.held('KeyS', 'ArrowDown') ? 1 : 0);
    const keySteer =
      (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0);
    const touchDriving =
      this.stick.active || this.touchGas || this.touchBrake || this.touchSteer !== null;
    this.drive.steer =
      this.touchSteer !== null ? this.touchSteer : touchDriving ? this.stick.x : keySteer;
    this.drive.throttle = touchDriving
      ? (this.touchGas ? 1 : 0) - (this.touchBrake ? 1 : 0)
      : keyThrottle;
    this.drive.handbrake = this.held('Space');
    this.drive.horn = this.touchHorn || this.held('KeyH');
    this.drive.brake = false;
    if (this.stick.active) {
      this.move.x = this.stick.x;
      this.move.y = this.stick.y;
      // Walk or run by how far the thumb pushes, with a gap between the two so a thumb
      // resting near the line doesn't flip between them every frame (which swapped the
      // animation and jerked the speed: the run looked like it glitched).
      const push = Math.hypot(this.stick.x, this.stick.y);
      if (push < 0.45) this.walk = true;
      else if (push > 0.65) this.walk = false;
      return;
    }
    const x = (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0);
    const y = (this.held('KeyW', 'ArrowUp') ? 1 : 0) - (this.held('KeyS', 'ArrowDown') ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    this.move.x = x / len;
    this.move.y = y / len;
    this.walk = this.held('ShiftLeft', 'ShiftRight');
  }

  /** Clears per-frame state after the frame used it. */
  endFrame(): void {
    this.look.x = 0;
    this.look.y = 0;
    this.zoom = 0;
    this.pressed.clear();
  }
}

/** Whether a key event belongs to a text field (chat), not to the game. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
