/**
 * The showroom at the Car Dealership (Phase 7): opened by stepping into the gold $ at the showroom's
 * door (or its "Buy a car" prompt). The cars for sale (shared CARS_FOR_SALE) down the side,
 * the one picked large with its numbers and price; buying asks once more, pays from the bank
 * (the API, keyed so a retry pays once) and puts the car in the garage. Then it can be driven
 * away from a delivery bay here, or fetched later from any car park.
 */
import { CAR_MODELS, CARS_FOR_SALE, DEALER, DEALER_MODELS } from '@fr33world/shared';
import { useEffect, useMemo, useState } from 'react';
import type { GarageCar } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

type OwnedCar = GarageCar;
type Stage =
  { at: 'browse' } | { at: 'confirm' } | { at: 'buying' } | { at: 'bought'; car: OwnedCar };

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US')}`;

/** The fastest and strongest cars on sale, for the bars. */
const TOP = Math.max(...DEALER_MODELS.map((m) => CAR_MODELS[m]?.topSpeed ?? 0));
const POWER = Math.max(...DEALER_MODELS.map((m) => CAR_MODELS[m]?.engine ?? 0));

export function DealerSheet({ game }: { game: Game }) {
  const [point, setPoint] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  const [stage, setStage] = useState<Stage>({ at: 'browse' });
  const [owned, setOwned] = useState<OwnedCar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  // The HUD redraws often, and this with it.
  const money = game.hud.money;

  useEffect(() => {
    game.onDealer = (p) => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setPoint(p);
    };
    return () => {
      game.onDealer = () => {};
    };
  }, [game]);
  useEffect(() => {
    if (point === null) return;
    let alive = true;
    setStage({ at: 'browse' });
    setError(null);
    game.garage().then(
      (c) => alive && setOwned(c),
      () => alive && setOwned(null),
    );
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setPoint(null);
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [game, point]);

  const model = DEALER_MODELS[pick] ?? 0;
  const spec = CAR_MODELS[model];
  const price = CARS_FOR_SALE[pick]?.price ?? 0;
  const counts = useMemo(() => {
    const n = new Map<number, number>();
    // The newcomer's rental isn't theirs to count.
    for (const c of owned ?? []) if (!c.expiresAt) n.set(c.model, (n.get(c.model) ?? 0) + 1);
    return n;
  }, [owned]);
  if (point === null || !spec) return null;

  const close = () => setPoint(null);
  const full = (owned?.length ?? 0) >= DEALER.garageMax;
  const short = money !== null && money < price;
  const choose = (i: number) => {
    setPick(i);
    setError(null);
    if (stage.at === 'confirm') setStage({ at: 'browse' });
  };
  const confirm = () => {
    setError(null);
    // One id for this purchase: tapping Buy again after a lost answer is the same purchase.
    setKey(`car-${crypto.randomUUID()}`);
    setStage({ at: 'confirm' });
  };
  const buy = async () => {
    setStage({ at: 'buying' });
    try {
      const car = await game.buyCar(model, key);
      setOwned((o) => [...(o ?? []), car]);
      setStage({ at: 'bought', car });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage({ at: 'confirm' });
    }
  };
  const driveAway = (car: OwnedCar) => {
    if (game.callCar(point, Number(car.id))) close();
    else setError("You're offline. Your car is in your garage: fetch it at any car park.");
  };

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet glass dealer-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="dealer-badge">$</span>
          <div className="dealer-head-text">
            <div className="sheet-title">{game.layout.points[point]?.name ?? 'Dealership'}</div>
            <div className="sheet-note">
              {money === null ? 'New cars on Sol Boulevard' : `${dollars(money)} in your bank`}
            </div>
          </div>
          <button type="button" className="dealer-close" onClick={close} aria-label="Close">
            ×
          </button>
        </div>

        <div className="dealer-body">
          <div className="dealer-hero">
            <img
              className="dealer-photo"
              src={`/ui/cars/${spec.id}.webp`}
              alt={spec.name}
              draggable={false}
            />
            <div className="dealer-name">
              <b>{spec.name}</b>
              <span className="dealer-price">{dollars(price)}</span>
            </div>
            <Bar label="Top speed" value={spec.topSpeed / TOP}>
              {`${Math.round(spec.topSpeed * 3.6)} km/h`}
            </Bar>
            <Bar label="Power" value={spec.engine / POWER}>
              {spec.engine >= 3500 ? 'Fast' : spec.engine >= 2800 ? 'Strong' : 'Easy'}
            </Bar>
            <Bar label="Size" value={spec.length / 6}>
              {`${spec.length.toFixed(1)} m`}
            </Bar>

            {error && <div className="login-error">{error}</div>}
            {stage.at === 'bought' ? (
              <div className="dealer-done">
                <div className="dealer-done-title">The {stage.car.name} is yours</div>
                <div className="sheet-note">
                  It's in your garage now: bring it to any car park from the blue P.
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => driveAway(stage.car)}
                >
                  Drive it away
                </button>
                <button type="button" className="btn" onClick={close}>
                  Later
                </button>
              </div>
            ) : stage.at === 'browse' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={short || full}
                onClick={confirm}
              >
                {full
                  ? `Garage full (${DEALER.garageMax} cars)`
                  : short
                    ? `${dollars(price - (money ?? 0))} short`
                    : `Buy for ${dollars(price)}`}
              </button>
            ) : (
              <div className="dealer-confirm">
                <div className="sheet-note">
                  Pay {dollars(price)} from your bank for the {spec.name}?
                </div>
                <div className="dealer-confirm-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={stage.at === 'buying'}
                    onClick={() => setStage({ at: 'browse' })}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={stage.at === 'buying'}
                    onClick={() => void buy()}
                  >
                    {stage.at === 'buying' ? 'Paying…' : 'Buy it'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="dealer-list">
            {DEALER_MODELS.map((m, i) => {
              const s = CAR_MODELS[m];
              if (!s) return null;
              const mine = counts.get(m) ?? 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`dealer-car${i === pick ? ' on' : ''}`}
                  onClick={() => choose(i)}
                >
                  <img src={`/ui/cars/${s.id}.webp`} alt="" draggable={false} />
                  <span className="dealer-car-text">
                    <b>{s.name}</b>
                    <small>{dollars(CARS_FOR_SALE[i]?.price ?? 0)}</small>
                  </span>
                  {mine > 0 && (
                    <span className="dealer-owned">{mine > 1 ? `×${mine}` : 'Owned'}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Bar({ label, value, children }: { label: string; value: number; children: string }) {
  return (
    <div className="dealer-bar">
      <span>{label}</span>
      <span className="dealer-bar-track">
        <span style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }} />
      </span>
      <span className="dealer-bar-value">{children}</span>
    </div>
  );
}
