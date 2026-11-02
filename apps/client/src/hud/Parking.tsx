/**
 * The car park's attendant (owner, 2026-10-30): opened by stepping into a car park's marker (or
 * its "Your cars" prompt). With the player's own car in this lot, its fuel and condition, and
 * buttons to fill it up and repair it for what it lacks. Then the cars the character owns (the
 * API's garage); picking one brings it to a free bay of this lot (the server says which), and
 * the one out before goes back to the garage.
 */
import { SERVICE } from '@fr33world/protocol';
import { CAR_MODELS, DAMAGE, FUEL, fuelCost, rentalLeft, repairCost } from '@fr33world/shared';
import { useEffect, useReducer, useState } from 'react';
import { formatMoney, type GarageCar } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

type OwnedCar = GarageCar;

export function ParkingSheet({ game }: { game: Game }) {
  const [point, setPoint] = useState<number | null>(null);
  const [cars, setCars] = useState<OwnedCar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    game.onCarCondition = redraw;
    game.onParking = (p) => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setPoint(p);
    };
    return () => {
      game.onParking = () => {};
      game.onCarCondition = () => {};
    };
  }, [game]);
  useEffect(() => {
    if (point === null) return;
    let alive = true;
    setCars(null);
    setError(null);
    game.garage().then(
      (c) => alive && setCars(c),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setPoint(null);
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [game, point]);

  if (point === null) return null;
  const lot = game.layout.points[point];
  // The player's own car, if it's in this lot (or just outside it).
  const area = game.layout.parking.find((l) => l.name === lot?.name)?.rect;
  const out = game.ownCarOut();
  const here =
    out &&
    area &&
    out.x > area.x0 - 8 &&
    out.x < area.x1 + 8 &&
    out.z > area.z0 - 8 &&
    out.z < area.z1 + 8
      ? out
      : null;
  const serve = (what: number) => {
    if (!game.service(point, what)) setError("You're offline.");
  };
  const close = () => setPoint(null);
  const bring = (car: OwnedCar) => {
    // The garage's ids are bigserials: JSON may carry them as strings.
    if (game.callCar(point, Number(car.id))) close();
    else setError("You're offline. Your cars come back once you're connected to the city.");
  };
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet glass guide parking-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="parking-p">P</span>
          <div>
            <div className="sheet-title">{lot?.name ?? 'Car park'}</div>
            <div className="sheet-note">Pick a car. It'll be waiting in a free bay.</div>
          </div>
        </div>
        {error && <div className="login-error">{error}</div>}
        {here && (
          <ServiceCard
            model={here.model}
            fuel={here.fuel}
            health={here.health}
            onFuel={() => serve(SERVICE.FUEL)}
            onRepair={() => serve(SERVICE.REPAIR)}
          />
        )}
        {!cars && !error && <div className="sheet-note">Opening your garage…</div>}
        {cars && cars.length === 0 && (
          <div className="sheet-note">
            No cars: your rental has gone back. Buy one at the Car Dealership on Sol Boulevard.
          </div>
        )}
        {cars && cars.length > 0 && (
          <div className="car-picks">
            {cars.map((c) => {
              const spec = CAR_MODELS[c.model];
              return (
                <button key={c.id} type="button" className="car-pick" onClick={() => bring(c)}>
                  {spec && <img className="car-pick-art" src={`/ui/cars/${spec.id}.webp`} alt="" />}
                  <span className="car-pick-text">
                    <b>{c.name}</b>
                    {c.expiresAt ? (
                      <small className="rental-note">
                        Free rental · due back in {rentalLeft(Date.parse(c.expiresAt) - Date.now())}
                      </small>
                    ) : (
                      spec && <small>Top speed {Math.round(spec.topSpeed * 3.6)} km/h</small>
                    )}
                  </span>
                  <span className="car-pick-go">Bring it</span>
                </button>
              );
            })}
          </div>
        )}
        <button type="button" className="btn" onClick={close}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** The car out in this lot: fuel and condition, and what filling and fixing it cost. */
function ServiceCard(props: {
  model: number;
  fuel: number;
  health: number;
  onFuel: () => void;
  onRepair: () => void;
}) {
  const spec = CAR_MODELS[props.model];
  const fill = fuelCost(props.fuel);
  const fix = repairCost(props.health);
  const bar = (label: string, v: number, warn: boolean) => (
    <div className="service-bar">
      <span>{label}</span>
      <span className="dealer-bar-track">
        <span
          style={{
            width: `${Math.round(v * 100)}%`,
            background: warn ? '#ff5a52' : v < 0.45 ? '#ffb547' : '#7def06',
          }}
        />
      </span>
      <b>{Math.round(v * 100)}%</b>
    </div>
  );
  return (
    <div className="service-card">
      <div className="service-head">
        {spec && <img src={`/ui/cars/${spec.id}.webp`} alt="" />}
        <div>
          <b>Your {spec?.name ?? 'car'}</b>
          <small>
            {props.health <= 0 ? 'Wrecked: it needs a repair to go' : 'In this car park'}
          </small>
        </div>
      </div>
      {bar('Fuel', props.fuel, props.fuel < FUEL.low)}
      {DAMAGE.enabled && bar('Condition', props.health, props.health <= 0)}
      <div className="service-actions">
        <button type="button" className="btn" disabled={fill === 0} onClick={props.onFuel}>
          {fill === 0 ? 'Tank full' : `Refuel · ${formatMoney(fill)}`}
        </button>
        {/* Damage is off for launch: nothing to repair. */}
        {DAMAGE.enabled && (
          <button type="button" className="btn" disabled={fix === 0} onClick={props.onRepair}>
            {fix === 0 ? 'Like new' : `Repair · ${formatMoney(fix)}`}
          </button>
        )}
      </div>
    </div>
  );
}
