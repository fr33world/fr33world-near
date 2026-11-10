/**
 * The Hospital's counter (owner, 2026-10-31; shared CARE): medicine and bandages, cheaper while
 * an EMS worker is in the building. Buying goes through the world server, which checks you're at
 * the counter; its answer comes back as what you carry, and a line in chat.
 */
import { CARE, carePrice } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { Funds, Modal, Price, Said, Tile } from '../ui/Modal.tsx';

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

  if (!open) return null;
  const staffed = game.counterStaffed();
  const care = game.arms()?.care ?? {};
  return (
    <Modal
      title="Pharmacy"
      accent="#2dd4bf"
      art="/ui/care/medicine.webp"
      medal="pharmacy"
      head={<Funds game={game} dollars />}
      rail={
        <p className="m-lore">
          <i className={`m-dot${staffed ? ' on' : ''}`} />
          {staffed ? 'Staff in' : `No staff: +${Math.round((CARE.selfServe - 1) * 100)}%`}
        </p>
      }
      onClose={() => setOpen(false)}
    >
      <div className="m-tiles">
        {CARE.items.map((item, i) => {
          const have = care[item.id] ?? 0;
          return (
            <Tile
              key={item.id}
              index={i}
              art={`/ui/care/${item.id}.webp`}
              name={item.name}
              meta={`+${item.heal} HP · ${have}/${CARE.max}`}
            >
              <Price
                label={have >= CARE.max ? 'Bag full' : formatMoney(carePrice(item.price, staffed))}
                disabled={have >= CARE.max}
                onClick={() => setSaid(game.buyCare(i) ? 'One moment…' : "You're offline.")}
              />
            </Tile>
          );
        })}
      </div>
      <Said text={said} />
    </Modal>
  );
}
