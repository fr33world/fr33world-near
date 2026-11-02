/**
 * Emotes (Phase 4): a fan of gestures and dances, opened with G on a keyboard or the emote
 * button on touch. Picking one plays it for everyone in view (Game.emote); moving ends it.
 */
import { EMOTES } from '@fr33world/protocol';
import { useEffect, useState } from 'react';
import type { Game } from '../game/Game.ts';
import { isTouchDevice } from '../game/quality.ts';

/** What the menu offers, each with its number on the wire. */
const MENU = EMOTES.flatMap((e, i) => ('menu' in e ? [] : [{ e, i }]));

export function Emotes({ game, driving }: { game: Game; driving: boolean }) {
  const [open, setOpen] = useState(false);
  const touch = isTouchDevice();
  // A gun in hand: Reload takes this spot, and there's no dancing with a gun out.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setArmed(game.hud.armed), 250);
    return () => window.clearInterval(t);
  }, [game]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT') return;
      if (e.code === 'KeyG' && !driving) setOpen((o) => !o);
      else if (e.code === 'Escape') setOpen(false);
      // 1–9 while open picks one.
      else if (open && /^Digit[1-9]$/.test(e.code)) {
        const i = Number(e.code.slice(5)) - 1;
        if (MENU[i]) {
          game.emote(MENU[i].i);
          setOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, driving, game]);
  useEffect(() => {
    if (driving) setOpen(false);
  }, [driving]);

  return (
    <>
      {touch && !driving && !armed && (
        <button
          type="button"
          className={`tbtn glass emote-button${open ? ' lit' : ''}`}
          aria-label="Emotes"
          onClick={() => setOpen((o) => !o)}
        >
          <SmileIcon />
        </button>
      )}
      {open && (
        <div className="emotes glass" role="menu">
          <div className="emotes-title">Emotes{!touch && <span> · G</span>}</div>
          <div className="emotes-grid">
            {MENU.map(({ e, i }) => (
              <button
                key={e.clip}
                type="button"
                role="menuitem"
                className="emote"
                onClick={() => {
                  game.emote(i);
                  setOpen(false);
                }}
              >
                {/* The character doing it (public/ui/emotes, rendered by
                    scripts/assets/ui-pictures.mjs), its name under. */}
                <img src={`/ui/emotes/${e.clip}.webp`} alt="" loading="lazy" draggable={false} />
                <span className="emote-name">
                  {!touch && i < 9 && <span className="kbd">{i + 1}</span>}
                  {e.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SmileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="9.2" cy="10" r="1.2" fill="currentColor" />
      <circle cx="14.8" cy="10" r="1.2" fill="currentColor" />
    </svg>
  );
}
