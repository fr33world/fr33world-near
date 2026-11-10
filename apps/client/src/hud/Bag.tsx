/**
 * The bag (owner, 2026-10-31): a button beside the minimap with how many things you carry. Tapped
 * (or B on a keyboard), it opens on pictures of what's in it, each with its count on the corner;
 * tapping one uses it. Pictures: public/ui/care, rendered by scripts/assets/care-icons.mjs.
 */
import { CONSUMABLES } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import type { Game } from '../game/Game.ts';

/** Where an item's picture is: the Hospital's in ui/care, Sunny's in ui/shop. */
const picture = (id: string) =>
  `/ui/${id === 'bandage' || id === 'medicine' ? 'care' : 'shop'}/${id}.webp`;

export function Bag({ game, left }: { game: Game; left: number }) {
  const [open, setOpen] = useState(false);
  const { hp, downed, driving } = game.hud;
  const care = game.arms()?.care ?? {};
  const carried = CONSUMABLES.flatMap((item, i) => {
    const count = care[item.id] ?? 0;
    return count > 0 ? [{ item, i, count }] : [];
  });
  const total = carried.reduce((sum, c) => sum + c.count, 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (e.code === 'KeyB') setOpen((o) => !o);
      else if (e.code === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open && document.pointerLockElement) void document.exitPointerLock();
  }, [open]);

  const why = driving
    ? 'Not while driving'
    : downed
      ? 'You’re down'
      : hp >= 100
        ? 'Full health'
        : null;
  return (
    <>
      <button
        type="button"
        className={`glass bag-button${open ? ' lit' : ''}`}
        style={{ left }}
        aria-label={`Bag, ${total} ${total === 1 ? 'item' : 'items'}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <BagIcon />
        {total > 0 && <b className="bag-count">{total}</b>}
      </button>
      {open && (
        <div className="bag glass" style={{ left: left + 46 }}>
          <div className="bag-title">Bag</div>
          {carried.length > 0 ? (
            <div className="bag-grid">
              {carried.map(({ item, i, count }) => (
                <button
                  key={item.id}
                  type="button"
                  className="bag-item"
                  disabled={why !== null}
                  aria-label={`Use a ${item.name}, ${count} left, adds ${item.heal} health`}
                  onClick={() => {
                    game.useCare(i);
                    setOpen(false);
                  }}
                >
                  <img src={picture(item.id)} alt="" draggable={false} />
                  <b className="bag-count">{count}</b>
                </button>
              ))}
            </div>
          ) : (
            <p className="bag-note">Empty</p>
          )}
          {carried.length > 0 && <p className="bag-note">{why ?? 'Tap to use'}</p>}
        </div>
      )}
    </>
  );
}

function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true">
      <path
        d="M8.5 8V6.5a3.5 3.5 0 0 1 7 0V8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M5.6 8h12.8l1.1 11a2 2 0 0 1-2 2.2H6.5a2 2 0 0 1-2-2.2L5.6 8Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M9 12.5h6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}
