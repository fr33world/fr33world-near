/**
 * Sunny's till: food and water for `$`, like everything the game sells (owner, 2026-11-13).
 * Stock and prices are the shop's own, read live.
 */
import { GOODS } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import { fetchShelf, formatMoney, type ShelfItem } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { Funds, Modal, Price, Said, Tile } from '../ui/Modal.tsx';

export function TillSheet({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [shelf, setShelf] = useState<ShelfItem[]>([]);
  const [said, setSaid] = useState<string | null>(null);

  const refresh = () => void fetchShelf().then(setShelf);

  useEffect(() => {
    game.onTill = () => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setSaid(null);
      setOpen(true);
      refresh();
    };
    return () => {
      game.onTill = () => {};
    };
  }, [game]);

  if (!open) return null;

  return (
    <Modal
      title="Sunny's Grocery"
      accent="#ffb02e"
      art="/ui/shop/meal.webp"
      medal="shop"
      head={<Funds game={game} />}
      onClose={() => setOpen(false)}
    >
      <div className="m-tiles">
        {shelf.map((item, n) => (
          <Tile
            key={item.id}
            index={n}
            art={`/ui/shop/${item.id}.webp`}
            name={item.name}
            dim={item.stock === 0}
            meta={`+${item.heal} HP · ${item.stock > 0 ? `${item.stock} left` : 'Sold out'}`}
          >
            <Price
              label={formatMoney(item.cents)}
              disabled={item.stock === 0}
              onClick={() => {
                const i = GOODS.findIndex((g) => g.id === item.id);
                setSaid(game.buyGood(i) ? 'One moment…' : "You're offline.");
                window.setTimeout(refresh, 1200);
              }}
            />
          </Tile>
        ))}
      </div>
      <Said text={said} />
    </Modal>
  );
}
