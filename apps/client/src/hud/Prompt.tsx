/**
 * The interaction prompt (interactions.ts): a glass disc over the thing in reach, with its
 * icon, a ring that fills while a hold-to-use is held, and what it does beside it (with the E
 * key on a keyboard). Tapping or clicking it uses it too. Something with no place in the world
 * (getting out of the car) shows as a chip at the bottom on desktop, and on the touch action
 * button. The marker follows its target every frame outside React.
 */
import { type ReactNode, useEffect, useRef } from 'react';
import type { Game } from '../game/Game.ts';
import type { InteractionIcon } from '../game/interactions.ts';
import { CarDoorIcon, DoorIcon, InfoIcon, JobIcon, SitIcon, TalkIcon } from '../ui/icons.tsx';

export const ACTION_ICONS: Record<InteractionIcon, () => ReactNode> = {
  // Getting in and out: a car door with its window, no words (owner, 2026-10-30).
  car: CarDoorIcon,
  exit: CarDoorIcon,
  info: InfoIcon,
  door: DoorIcon,
  talk: TalkIcon,
  job: JobIcon,
  sit: SitIcon,
};

/** The ring's circumference (r = 21). */
const RING = 2 * Math.PI * 21;

export function Prompt({ game, touch }: { game: Game; touch: boolean }) {
  const marker = useRef<HTMLButtonElement>(null);
  const hud = game.hud;

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const el = marker.current;
      if (!el) return;
      const at = game.promptMarker(window.innerWidth, window.innerHeight);
      el.style.visibility = at ? 'visible' : 'hidden';
      if (at) el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
      const ring = el.querySelector<SVGCircleElement>('.prompt-ring');
      if (ring) ring.style.strokeDashoffset = String(RING * (1 - game.interactions.progress));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [game]);

  if (!hud.action || !hud.actionIcon) return null;
  const Glyph = ACTION_ICONS[hud.actionIcon];
  const placed = !!game.interactions.current?.at;
  const down = () => {
    game.input.press('interact');
    game.input.setHeld('interact', true);
  };
  const up = () => game.input.setHeld('interact', false);
  return (
    <>
      <button
        ref={marker}
        type="button"
        className="prompt"
        style={{ visibility: 'hidden' }}
        aria-label={hud.action}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as Element).setPointerCapture(e.pointerId);
          down();
        }}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="prompt-disc glass">
          <svg viewBox="0 0 48 48" className="prompt-progress" aria-hidden="true">
            <circle className="prompt-ring" cx="24" cy="24" r="21" strokeDasharray={RING} />
          </svg>
          <Glyph />
        </span>
        {/* On a phone the car door says it all; a keyboard still wants to see E. */}
        {!(touch && (hud.actionIcon === 'car' || hud.actionIcon === 'exit')) && (
          <span className="prompt-label glass">
            {!touch && <span className="kbd">E</span>}
            {hud.action}
            {game.interactions.current?.holdMs ? <em>hold</em> : null}
          </span>
        )}
      </button>
      {!touch && !placed && (
        <div className="chip glass prompt-chip" style={hud.driving ? { bottom: 200 } : undefined}>
          <span className="kbd">E</span> {hud.action}
        </div>
      )}
    </>
  );
}
