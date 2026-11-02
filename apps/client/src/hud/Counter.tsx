/**
 * The Hospital's counter (owner, 2026-10-31; shared CARE): medicine and bandages, cheaper while
 * an EMS worker is in the building. Buying goes through the world server, which checks you're at
 * the counter; its answer comes back as what you carry, and a line in chat.
 */
import { CARE, carePrice } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

export function CounterSheet({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    game.onCounter = () => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setSaid(null);
      setOpen(true);
    };
    return () => {
      game.onCounter = () => {};
    };
  }, [game]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const staffed = game.counterStaffed();
  const care = game.arms()?.care ?? {};
  return (
    <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="sheet glass guide gun-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="gun-badge">+</span>
          <div>
            <div className="sheet-title">Pharmacy</div>
            <div className="sheet-note">
              {staffed
                ? 'An EMS worker is serving.'
                : `Self-service: ${Math.round((CARE.selfServe - 1) * 100)}% more with no staff in.`}
            </div>
          </div>
        </div>
        {CARE.items.map((item, i) => {
          const have = care[item.id] ?? 0;
          return (
            <div key={item.id} className="gun-row">
              <img className="care-picture" src={`/ui/care/${item.id}.webp`} alt="" />
              <span className="gun-what">
                <b>{item.name}</b>
                <small>
                  +{item.heal} health · you carry {have} of {CARE.max}
                </small>
              </span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={have >= CARE.max}
                onClick={() => setSaid(game.buyCare(i) ? 'One moment…' : "You're offline.")}
              >
                {formatMoney(carePrice(item.price, staffed))}
              </button>
            </div>
          );
        })}
        {said && <div className="sheet-note">{said}</div>}
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Leave
        </button>
      </div>
    </div>
  );
}
