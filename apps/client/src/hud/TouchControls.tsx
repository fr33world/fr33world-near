/**
 * Landscape touch controls (PRD §10.1): a floating joystick that appears where the left thumb
 * lands, a look pad over the right of the screen, and thumb-sized action buttons. Everything
 * writes straight into the game's Input; pointer moves never re-render React.
 */
import { type CSSProperties, useEffect, useRef } from 'react';
import type { Input } from '../game/input.ts';
import type { InteractionIcon } from '../game/interactions.ts';
import { FireIcon, JumpIcon, MicIcon, PunchIcon } from '../ui/icons.tsx';
import { ACTION_ICONS } from './Prompt.tsx';

const STICK_RADIUS = 56;
const LOOK_GAIN = 1.7;
/** Zoom per pixel the two fingers move together or apart. */
const PINCH_ZOOM = 0.004;

export function TouchControls({
  input,
  action,
  actionIcon,
  driving,
  armed,
  weapons,
  voice,
  talking,
}: {
  input: Input;
  action: string | null;
  actionIcon: InteractionIcon | null;
  driving: boolean;
  armed: boolean;
  /** Owns a weapon: the button that takes one in hand (and puts it away). */
  weapons: boolean;
  /** Proximity voice is connected: show the mic toggle. */
  voice: boolean;
  talking: boolean;
}) {
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const stickId = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const lookId = useRef<number | null>(null);
  const lookAt = useRef({ x: 0, y: 0 });
  /** A second finger on the look pad: pinching zooms. Where it is, and their distance apart. */
  const pinch = useRef<{ id: number; x: number; y: number; apart: number } | null>(null);
  /** A finger left the look pad. The one still down carries on looking. */
  const lookEnd = (e: { pointerId: number }) => {
    const two = pinch.current;
    if (e.pointerId === two?.id) pinch.current = null;
    else if (e.pointerId === lookId.current) {
      lookId.current = two?.id ?? null;
      if (two) lookAt.current = { x: two.x, y: two.y };
      pinch.current = null;
    }
  };
  /**
   * Run lock (owner, 2026-10-30): slide the stick up past its top and let go there, and the
   * character keeps running forward (a running badge above the stick) until the stick is
   * touched again.
   */
  const lock = useRef<HTMLDivElement>(null);
  const lockArmed = useRef(false);
  const autoRun = useRef(false);
  const setLock = (state: 'off' | 'hint' | 'armed' | 'on') => {
    const el = lock.current;
    if (el) el.dataset.state = state;
  };

  /**
   * Lets go of everything held: the stick, the look pad, pedals, mic, interact. A finger whose
   * lift never arrives (the pad hidden under it on getting into a car, a sheet opened over it,
   * iOS taking the touch for a system gesture) would otherwise keep a control forever, and it
   * would ignore every new touch.
   */
  const releaseAll = () => {
    stickId.current = null;
    autoRun.current = false;
    lockArmed.current = false;
    setLock('off');
    lookId.current = null;
    pinch.current = null;
    input.setStick(0, 0, false);
    input.touchGas = false;
    input.touchBrake = false;
    for (const k of ['mic', 'interact', 'fire']) input.setHeld(k, false);
    showStick(110, window.innerHeight - 120, 0, 0, false);
  };

  // The gun put away with Fire still held: its button has gone, and its release with it.
  useEffect(() => {
    if (!armed) input.setHeld('fire', false);
  }, [armed, input]);

  // Walking ↔ driving swaps the controls under the thumbs: start clean.
  useEffect(() => {
    releaseAll();
  }, [driving]);

  // Leaving the app (or the window losing focus) can drop the lifts of fingers held down.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) releaseAll();
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [input]);

  const showStick = (x: number, y: number, kx: number, ky: number, on: boolean) => {
    const b = base.current;
    const k = knob.current;
    if (!b || !k) return;
    b.style.opacity = on ? '1' : '0.35';
    b.style.transform = `translate(${x - STICK_RADIUS}px, ${y - STICK_RADIUS}px)`;
    k.style.transform = `translate(${kx}px, ${ky}px)`;
  };

  return (
    <div style={layer}>
      {/* Left half: movement (in a car, the steering wheel instead). */}
      {driving && <SteerPad input={input} />}
      <div
        style={{ ...pad, left: 0, width: '45%', display: driving ? 'none' : undefined }}
        onPointerDown={(e) => {
          if (stickId.current !== null) return;
          stickId.current = e.pointerId;
          // A touch on the stick ends a run lock.
          autoRun.current = false;
          lockArmed.current = false;
          setLock('hint');
          (e.target as Element).setPointerCapture(e.pointerId);
          origin.current = { x: e.clientX, y: e.clientY };
          showStick(e.clientX, e.clientY, 0, 0, true);
        }}
        onPointerMove={(e) => {
          if (e.pointerId !== stickId.current) return;
          let dx = e.clientX - origin.current.x;
          let dy = e.clientY - origin.current.y;
          // Up past the stick's top, into the lock: let go there to keep running.
          const armedNow = dy < -STICK_RADIUS * 1.55 && Math.abs(dx) < STICK_RADIUS;
          if (armedNow !== lockArmed.current) {
            lockArmed.current = armedNow;
            setLock(armedNow ? 'armed' : 'hint');
          }
          const len = Math.hypot(dx, dy);
          if (len > STICK_RADIUS) {
            dx = (dx / len) * STICK_RADIUS;
            dy = (dy / len) * STICK_RADIUS;
          }
          input.setStick(dx / STICK_RADIUS, -dy / STICK_RADIUS, true);
          showStick(origin.current.x, origin.current.y, dx, dy, true);
        }}
        onPointerUp={(e) => {
          if (e.pointerId !== stickId.current) return;
          stickId.current = null;
          if (lockArmed.current) {
            // Locked: full ahead, the knob held at the top.
            lockArmed.current = false;
            autoRun.current = true;
            setLock('on');
            input.setStick(0, 1, true);
            showStick(origin.current.x, origin.current.y, 0, -STICK_RADIUS, true);
            return;
          }
          setLock('off');
          input.setStick(0, 0, false);
          showStick(110, window.innerHeight - 120, 0, 0, false);
        }}
        onPointerCancel={(e) => {
          if (e.pointerId !== stickId.current) return;
          stickId.current = null;
          input.setStick(0, 0, false);
          showStick(110, window.innerHeight - 120, 0, 0, false);
        }}
        onLostPointerCapture={(e) => {
          if (e.pointerId !== stickId.current) return;
          stickId.current = null;
          input.setStick(0, 0, false);
          showStick(110, window.innerHeight - 120, 0, 0, false);
        }}
      />
      {/* Right side: camera. */}
      <div
        style={{ ...pad, right: 0, width: '55%' }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          if (lookId.current !== null) {
            if (!pinch.current) {
              const apart = Math.hypot(e.clientX - lookAt.current.x, e.clientY - lookAt.current.y);
              pinch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, apart };
            }
            return;
          }
          lookId.current = e.pointerId;
          lookAt.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const two = pinch.current;
          if (two && (e.pointerId === two.id || e.pointerId === lookId.current)) {
            if (e.pointerId === two.id) {
              two.x = e.clientX;
              two.y = e.clientY;
            } else {
              lookAt.current = { x: e.clientX, y: e.clientY };
            }
            const apart = Math.hypot(two.x - lookAt.current.x, two.y - lookAt.current.y);
            // Fingers apart bring the view in, as on a photo.
            input.addZoom((two.apart - apart) * PINCH_ZOOM);
            two.apart = apart;
            return;
          }
          if (e.pointerId !== lookId.current) return;
          input.addLook(
            (e.clientX - lookAt.current.x) * LOOK_GAIN,
            (e.clientY - lookAt.current.y) * LOOK_GAIN,
          );
          lookAt.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={lookEnd}
        onPointerCancel={lookEnd}
        onLostPointerCapture={lookEnd}
      />
      <div ref={base} style={{ ...stickBase, display: driving ? 'none' : undefined }}>
        <div ref={knob} style={stickKnob} />
        {/* The run lock, above the stick: shown while the stick is held, lit when it's on. */}
        <div ref={lock} className="run-lock" data-state="off">
          <RunIcon />
        </div>
      </div>
      {driving ? (
        <>
          {/* The pedals, as in a car: the brake on the left and shorter, the accelerator taller. */}
          <button
            type="button"
            className="pedal accelerator"
            aria-label="Accelerator"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              input.touchGas = true;
            }}
            onPointerUp={() => (input.touchGas = false)}
            onPointerCancel={() => (input.touchGas = false)}
          >
            <PedalArt tall />
          </button>
          <button
            type="button"
            className="pedal brake"
            aria-label="Brake"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              input.touchBrake = true;
            }}
            onPointerUp={() => (input.touchBrake = false)}
            onPointerCancel={() => (input.touchBrake = false)}
          >
            <PedalArt />
          </button>
          <button
            type="button"
            className="tbtn glass horn-button"
            aria-label="Horn"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              input.touchHorn = true;
            }}
            onPointerUp={() => (input.touchHorn = false)}
            onPointerCancel={() => (input.touchHorn = false)}
          >
            <HornIcon />
          </button>
        </>
      ) : (
        <button
          className="tbtn big glass"
          style={{ right: 'var(--safe-r)', bottom: 28 }}
          onPointerDown={() => input.press('jump')}
        >
          <JumpIcon />
          Jump
        </button>
      )}
      {!driving && !armed && (
        <button
          className="tbtn big glass"
          style={{ right: 'calc(var(--safe-r) + 98px)', bottom: 28 }}
          onPointerDown={() => input.press('punch')}
        >
          <PunchIcon />
          Punch
        </button>
      )}
      {!driving && armed && (
        <button
          className="tbtn big glass"
          style={{ right: 'calc(var(--safe-r) + 98px)', bottom: 28 }}
          // Held, it keeps firing; it aims too (Game).
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            input.press('fire');
            input.setHeld('fire', true);
          }}
          onPointerUp={() => input.setHeld('fire', false)}
          onPointerCancel={() => input.setHeld('fire', false)}
        >
          <FireIcon />
          Fire
        </button>
      )}
      {!driving && weapons && (
        <button
          type="button"
          className={`tbtn glass${armed ? ' lit' : ''}`}
          style={{ right: 'calc(var(--safe-r) + 10px)', bottom: 196 }}
          aria-label="Weapon"
          onPointerDown={() => input.press('weapon')}
        >
          <GunIcon />
        </button>
      )}
      {!driving && armed && (
        <button
          type="button"
          className="tbtn glass"
          style={{ right: 'calc(var(--safe-r) + 196px)', bottom: 40 }}
          aria-label="Reload"
          onPointerDown={() => input.press('reload')}
        >
          <ReloadIcon />
        </button>
      )}
      {voice && (
        <button
          className={`tbtn glass${talking ? ' lit' : ''}`}
          style={
            driving
              ? { right: 'calc(var(--safe-r) + 132px)', bottom: 'calc(var(--safe-b) + 146px)' }
              : { right: 'calc(var(--safe-r) + 10px)', bottom: 122 }
          }
          // Hold to talk (owner, 2026-10-29): the mic is live only while a finger is on it,
          // so nobody is left talking to the whole street by accident.
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            input.setHeld('mic', true);
          }}
          onPointerUp={() => input.setHeld('mic', false)}
          onPointerCancel={() => input.setHeld('mic', false)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MicIcon />
          {talking ? 'Talking' : 'Hold'}
        </button>
      )}
      {action && actionIcon && (
        <button
          // Getting in or out of a car: a round car-door button, no words; the rest say what.
          className={
            actionIcon === 'car' || actionIcon === 'exit'
              ? 'tbtn glass car-door'
              : 'tbtn pill glass'
          }
          aria-label={action}
          style={{
            // Beside the weapon button when there is one.
            right: !driving && weapons ? 'calc(var(--safe-r) + 84px)' : 'var(--safe-r)',
            // Above the buttons on foot, above the pedals in a car.
            bottom: driving ? 'calc(var(--safe-b) + 146px)' : 196,
          }}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            input.press('interact');
            input.setHeld('interact', true);
          }}
          onPointerUp={() => input.setHeld('interact', false)}
          onPointerCancel={() => input.setHeld('interact', false)}
        >
          {ACTION_ICONS[actionIcon]()}
          {actionIcon !== 'car' && actionIcon !== 'exit' && action}
        </button>
      )}
    </div>
  );
}

const layer: CSSProperties = { position: 'fixed', inset: 0, pointerEvents: 'none' };
const pad: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  pointerEvents: 'auto',
  touchAction: 'none',
};
const stickBase: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: STICK_RADIUS * 2,
  height: STICK_RADIUS * 2,
  borderRadius: '50%',
  background: 'rgba(14, 16, 20, 0.3)',
  border: '1px solid rgba(255, 255, 255, 0.22)',
  opacity: 0.35,
  transform: `translate(${110 - STICK_RADIUS}px, calc(100vh - ${120 + STICK_RADIUS}px))`,
  pointerEvents: 'none',
  backdropFilter: 'blur(var(--glass-blur))',
};
const stickKnob: CSSProperties = {
  position: 'absolute',
  left: STICK_RADIUS - 26,
  top: STICK_RADIUS - 26,
  width: 52,
  height: 52,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.9)',
  boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
};

/**
 * Steering (owner, 2026-10-30: "not that big", like the reference game): two small round
 * buttons, a left arrow and a right arrow, bottom left. Held, the car steers that way (the car
 * eases the wheels round, as with A and D); the thumb can slide from one to the other. Let go
 * and the car straightens. Writes into the game's input directly.
 */
function SteerPad({ input }: { input: Input }) {
  const pad = useRef<HTMLDivElement>(null);
  const id = useRef<number | null>(null);

  const set = (steer: number | null) => {
    input.touchSteer = steer;
    const el = pad.current;
    if (el) {
      el.classList.toggle('left', steer !== null && steer < 0);
      el.classList.toggle('right', steer !== null && steer > 0);
    }
  };
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Right of the middle steers right (+, as the D key and the stick do).
    return e.clientX < r.left + r.width / 2 ? -1 : 1;
  };
  useEffect(() => () => set(null), []);

  return (
    <div
      ref={pad}
      className="steer-pad"
      onPointerDown={(e) => {
        if (id.current !== null) return;
        id.current = e.pointerId;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        set(at(e));
      }}
      onPointerMove={(e) => {
        if (e.pointerId === id.current) set(at(e));
      }}
      onPointerUp={(e) => {
        if (e.pointerId !== id.current) return;
        id.current = null;
        set(null);
      }}
      onPointerCancel={() => {
        id.current = null;
        set(null);
      }}
      onLostPointerCapture={() => {
        id.current = null;
        set(null);
      }}
    >
      <span className="steer-btn left glass">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.5 6 8.5 12l6 6" />
        </svg>
      </span>
      <span className="steer-btn right glass">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.5 6l6 6-6 6" />
        </svg>
      </span>
    </div>
  );
}

/** A pedal: a ribbed rubber pad on its arm (taller for the accelerator). */
function PedalArt({ tall = false }: { tall?: boolean }) {
  const h = tall ? 120 : 84;
  return (
    <svg viewBox={`0 0 64 ${h}`} aria-hidden="true">
      <rect
        x="4"
        y="2"
        width="56"
        height={h - 4}
        rx="12"
        fill="rgba(20,22,26,0.9)"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="1.5"
      />
      {Array.from({ length: tall ? 7 : 5 }, (_, i) => (
        <rect
          key={i}
          x="13"
          y={14 + i * 14}
          width="38"
          height="5"
          rx="2.5"
          fill="rgba(255,255,255,0.22)"
        />
      ))}
    </svg>
  );
}

function RunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="14.5" cy="4.5" r="2" fill="currentColor" stroke="none" />
      <path d="M6 11.5 9.5 8.5l3.5 1 2 3.5 3 1" />
      <path d="M13 10l-2 5 3.5 2.5L13 22" />
      <path d="M11 15l-3 2-3.5-.5" />
    </svg>
  );
}

/** A horn: a trumpet bell with sound coming out. */
function HornIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10v4h3l7 4V6L6 10z" />
      <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

/** A pistol, for taking a weapon in hand. */
function GunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8h17v4h-9l-1.5 6H6l1.5-6H3z" />
      <path d="M11 12l-.5 2h-2" />
    </svg>
  );
}

/** Two arrows round a circle, for reloading. */
function ReloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 0 1-14 5.3M4 12A8 8 0 0 1 18 6.7" />
      <path d="M18 3v4h-4M6 21v-4h4" />
    </svg>
  );
}
