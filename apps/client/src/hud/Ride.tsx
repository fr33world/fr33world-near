/**
 * A taxi ride on screen (the phone's Taxi app): "Calling a cab" while the server decides, then
 * the ride itself (a cab card over the darkened city, the meter filling for a few seconds
 * while the player is carried there), or why no cab came.
 */
import { useEffect, useState } from 'react';
import { formatMoney } from '../game/api.ts';
import type { Game, Ride } from '../game/Game.ts';

export function RideCard({ game }: { game: Game }) {
  const [ride, setRide] = useState<Ride | null>(null);

  useEffect(() => {
    game.onRide = (r) => {
      if (document.pointerLockElement && r.state !== 'refused') void document.exitPointerLock();
      setRide(r);
    };
    return () => {
      game.onRide = () => {};
    };
  }, [game]);
  useEffect(() => {
    if (!ride) return;
    // Calling waits for the answer (a few seconds at most); the rest close by themselves.
    const ms =
      ride.state === 'riding' ? ride.seconds * 1000 + 400 : ride.state === 'refused' ? 4000 : 8000;
    const t = window.setTimeout(() => setRide(null), ms);
    return () => window.clearTimeout(t);
  }, [ride]);

  if (!ride) return null;
  if (ride.state === 'refused')
    return (
      <div className="ride-toast glass" role="status">
        <TaxiGlyph />
        <span>{ride.text}</span>
      </div>
    );
  const riding = ride.state === 'riding';
  return (
    <div className={`ride-cover${riding ? ' on' : ''}`} role="status">
      <div className="ride-card glass">
        <div className="ride-sign">
          <TaxiGlyph />
          <span>{riding ? 'On the way' : 'Calling a cab…'}</span>
        </div>
        <div className="ride-to">{ride.to}</div>
        <div className="ride-meter">
          <span
            key={ride.state}
            style={riding ? { animationDuration: `${ride.seconds}s` } : undefined}
            className={riding ? 'run' : 'wait'}
          />
        </div>
        <div className="ride-note">
          {!riding
            ? 'One moment'
            : ride.cents > 0
              ? `Fare ${formatMoney(ride.cents)}`
              : 'Free ride'}
        </div>
      </div>
    </div>
  );
}

function TaxiGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 7.5 10 5.5h4l.5 2" />
      <path d="M4 15.5v-3l2-5h12l2 5v3" />
      <path d="M3 15.5h18v2.5H3z" />
      <circle cx="7.5" cy="18.5" r="1.4" />
      <circle cx="16.5" cy="18.5" r="1.4" />
    </svg>
  );
}
