/**
 * The counter at the Gun Store, and the black-market dealer by the containers (Phase 8; shared
 * ARMORY): what's for sale there, what you already carry, and why something isn't for you yet
 * (no licence, below level 5, no gang rank). Buying goes through the world server, which checks
 * you're at the counter; its answer comes back as what you carry, and a line in chat.
 */
import { ARMORY, levelOf, WEAPONS } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { Funds, Modal, Price, Said, Tile } from '../ui/Modal.tsx';

export function GunStoreSheet({ game }: { game: Game }) {
  const [point, setPoint] = useState<number | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    game.onGunStore = (p) => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setSaid(null);
      setPoint(p);
    };
    return () => {
      game.onGunStore = () => {};
    };
  }, [game]);

  if (point === null) return null;
  const p = game.layout.points[point];
  const black = p?.kind === 'black_market';
  const arms = game.arms();
  const level = levelOf(game.hud.xp ?? 0).level;
  const close = () => setPoint(null);
  const buy = (index: number) => {
    if (!game.buyArms(point, index)) setSaid("You're offline.");
    else setSaid('One moment…');
  };
  // Item 0 is the licence, then shared ARMORY.items in order (the server's numbering).
  const rows = ARMORY.items
    .map((item, i) => ({ item, index: i + 1 }))
    .filter(({ item }) => item.where === (black ? 'black_market' : 'store'));
  return (
    <Modal
      title={black ? 'By the containers' : 'Gun Store'}
      kicker={black ? 'Off the books' : 'Mid City'}
      accent={black ? '#ff5a52' : '#e0b43e'}
      art={`/ui/shop/${black ? 'rifle' : 'pistol'}.webp`}
      ghost={black ? 'NO NAMES' : 'ARMS'}
      medal={black ? 'black' : 'gun'}
      head={<Funds game={game} dollars />}
      rail={
        <p className="m-lore">
          {black
            ? '“Keep your voice down. Only for people I know.”'
            : 'Licensed firearms. Safe zones are gun-free.'}
        </p>
      }
      onClose={close}
    >
      <div className="m-tiles">
        {!black && (
          <Tile
            art="/ui/shop/licence.webp"
            name="Pistol licence"
            dim={arms?.licence}
            meta={
              arms?.licence
                ? 'You hold one.'
                : level < ARMORY.licence.minLevel
                  ? `From level ${ARMORY.licence.minLevel} (you're ${level}).`
                  : 'Lets you buy and carry a pistol.'
            }
          >
            <Price
              label={arms?.licence ? 'Owned' : formatMoney(ARMORY.licence.price)}
              locked={!arms?.licence && level < ARMORY.licence.minLevel}
              disabled={arms?.licence}
              onClick={() => buy(0)}
            />
          </Tile>
        )}
        {rows.map(({ item, index }, i) => {
          const owned = arms?.weapons.includes(item.weapon) ?? false;
          const rounds = arms?.rounds[item.weapon] ?? 0;
          const max = ARMORY.maxRounds[item.weapon] ?? 0;
          const blocked = item.rounds
            ? !owned
              ? `Buy the ${WEAPONS[item.weapon]?.name ?? 'weapon'} first.`
              : rounds + item.rounds > max
                ? `You carry ${rounds}: at most ${max}.`
                : `You carry ${rounds}.`
            : owned
              ? 'You have one.'
              : !black && !arms?.licence
                ? 'Needs a pistol licence.'
                : null;
          const off = item.rounds
            ? !owned || rounds + item.rounds > max
            : owned || (!black && !arms?.licence);
          const label = !item.rounds && owned ? 'Owned' : formatMoney(item.price);
          return (
            <Tile
              key={item.id}
              index={i + 1}
              art={`/ui/shop/${item.id}.webp`}
              name={item.name}
              dim={!item.rounds && owned}
              meta={blocked ?? (black ? 'For gang members of rank.' : 'Yours to keep.')}
            >
              <Price
                label={label}
                locked={off && !(!item.rounds && owned)}
                disabled={off}
                onClick={() => buy(index)}
              />
            </Tile>
          );
        })}
      </div>
      <Said text={said} />
    </Modal>
  );
}
