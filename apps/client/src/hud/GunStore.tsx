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
  useEffect(() => {
    if (point === null) return;
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setPoint(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [point]);

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
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet glass guide gun-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="gun-badge">{black ? '?' : '◎'}</span>
          <div>
            <div className="sheet-title">{black ? 'By the containers' : 'Gun Store'}</div>
            <div className="sheet-note">
              {black
                ? '“Keep your voice down. Only for people I know.”'
                : 'Licensed firearms. Safe zones are gun-free.'}
            </div>
          </div>
        </div>
        {!black && (
          <div className="gun-row">
            <span className="gun-what">
              <b>Pistol licence</b>
              <small>
                {arms?.licence
                  ? 'You hold one.'
                  : level < ARMORY.licence.minLevel
                    ? `From level ${ARMORY.licence.minLevel} (you're ${level}).`
                    : 'Lets you buy and carry a pistol.'}
              </small>
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={arms?.licence || level < ARMORY.licence.minLevel}
              onClick={() => buy(0)}
            >
              {formatMoney(ARMORY.licence.price)}
            </button>
          </div>
        )}
        {rows.map(({ item, index }) => {
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
          return (
            <div key={item.id} className="gun-row">
              <span className="gun-what">
                <b>{item.name}</b>
                <small>{blocked ?? (black ? 'For gang members of rank.' : 'Yours to keep.')}</small>
              </span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={off}
                onClick={() => buy(index)}
              >
                {formatMoney(item.price)}
              </button>
            </div>
          );
        })}
        {said && <div className="sheet-note">{said}</div>}
        <button type="button" className="btn" onClick={close}>
          Leave
        </button>
      </div>
    </div>
  );
}
