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
import { Funds, Modal, Stat, Tile } from '../ui/Modal.tsx';

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
    return () => {
      alive = false;
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
  const shown = CAR_MODELS[here?.model ?? cars?.[0]?.model ?? -1];
  return (
    <Modal
      title={lot?.name ?? 'Car park'}
      kicker="Car park"
      accent="#4c8dff"
      art={shown ? `/ui/cars/${shown.id}.webp` : '/ui/medals/parking.webp'}
      ghost="GARAGE"
      medal="parking"
      head={<Funds game={game} dollars />}
      rail={<p className="m-lore">Pick a car. It'll be waiting in a free bay.</p>}
      onClose={close}
    >
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
      {!cars && !error && <p className="m-empty">Opening your garage…</p>}
      {cars && cars.length === 0 && (
        <p className="m-empty">
          No cars: your rental has gone back. Buy one at the Car Dealership on Sol Boulevard.
        </p>
      )}
      {cars && cars.length > 0 && (
        <div className="m-tiles wide">
          {cars.map((c, i) => {
            const spec = CAR_MODELS[c.model];
            return (
              <Tile
                key={c.id}
                index={i}
                art={spec ? `/ui/cars/${spec.id}.webp` : undefined}
                name={c.name}
                meta={
                  c.expiresAt
                    ? `Free rental · due back in ${rentalLeft(Date.parse(c.expiresAt) - Date.now())}`
                    : spec && `Top speed ${Math.round(spec.topSpeed * 3.6)} km/h`
                }
              >
                <button type="button" className="m-btn go small" onClick={() => bring(c)}>
                  Bring it
                </button>
              </Tile>
            );
          })}
        </div>
      )}
    </Modal>
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
  const warn = props.fuel < FUEL.low;
  return (
    <div className={`m-service${warn ? ' warn' : ''}`}>
      <div className="m-row-text">
        <b>Your {spec?.name ?? 'car'}</b>
        <small>{props.health <= 0 ? 'Wrecked: it needs a repair to go' : 'In this car park'}</small>
      </div>
      <Stat label="Fuel" value={props.fuel}>{`${Math.round(props.fuel * 100)}%`}</Stat>
      {DAMAGE.enabled && (
        <Stat label="Condition" value={props.health}>{`${Math.round(props.health * 100)}%`}</Stat>
      )}
      <div className="m-actions">
        <button type="button" className="m-btn small" disabled={fill === 0} onClick={props.onFuel}>
          {fill === 0 ? 'Tank full' : `Refuel · ${formatMoney(fill)}`}
        </button>
        {/* Damage is off for launch: nothing to repair. */}
        {DAMAGE.enabled && (
          <button
            type="button"
            className="m-btn small"
            disabled={fix === 0}
            onClick={props.onRepair}
          >
            {fix === 0 ? 'Like new' : `Repair · ${formatMoney(fix)}`}
          </button>
        )}
      </div>
    </div>
  );
}
