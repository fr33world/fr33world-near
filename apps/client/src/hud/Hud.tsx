import type { CSSProperties } from 'react';
import { levelOf } from '@fr33world/shared';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { isTouchDevice } from '../game/quality.ts';
import { Dashboard } from './Dashboard.tsx';
import { DealerSheet } from './Dealer.tsx';
import { DispatchCard } from './Dispatch.tsx';
import { Guide } from './Guide.tsx';
import { ComputerSheet } from './Computer.tsx';
import { JoinSheet } from './Join.tsx';
import { Bag } from './Bag.tsx';
import { CounterSheet } from './Counter.tsx';
import { TillSheet } from './Till.tsx';
import { GunStoreSheet } from './GunStore.tsx';
import { MiningSwing, RewardToasts, TaskPanel } from './Jobs.tsx';
import { Minimap } from './Minimap.tsx';
import { ParkingSheet } from './Parking.tsx';
import { Phone, PHONE_DEMO } from './Phone.tsx';
import { Prompt } from './Prompt.tsx';
import { RideCard } from './Ride.tsx';
import { TutorialCard } from './TutorialCard.tsx';
import { UsdcPill, WalletSheet } from './Usdc.tsx';
import { BarsIcon, CashIcon, ClockIcon } from '../ui/icons.tsx';

/**
 * The HUD (after the owner's photo, 2026-11-10): the minimap at the top left with health and
 * the player's card under it; along the top right, up to the settings gear, one bar with the
 * time, frame rate and ping, the game's `$`, and the USDC balance that opens the wallet. Then
 * the speedometer, crosshair, desktop key hints, and the interaction prompt (Prompt.tsx) with
 * the city guide it can open.
 */
export function Hud({ game }: { game: Game }) {
  const hud = game.hud;
  // For the touch buttons' places in a car (ui.css body.driving).
  document.body.classList.toggle('driving', hud.driving);
  const touch = isTouchDevice();
  const mapSize = touch ? 112 : 136;
  const ping =
    hud.net === 'online' ? `${hud.ping} ms` : hud.net.startsWith('offline') ? 'offline' : '…';
  return (
    <>
      <div style={{ ...corner, left: 'var(--safe-l)' }}>
        {hud.indoors ? (
          <div className="glass room-name">{hud.indoors}</div>
        ) : (
          <Minimap game={game} size={mapSize} />
        )}
        <HealthBar hp={hud.hp} width={mapSize} />
        <Bag game={game} left={mapSize + 8} />
        {hud.xp !== null && (
          <PlayerCard name={game.playerName} xp={hud.xp} portrait={game.portrait} />
        )}
        {game.waypoints.target && (
          <div className="glass waypoint-chip" style={{ maxWidth: mapSize + 60 }}>
            <i />
            {game.waypoints.target.label} · {formatDistance(game.waypoints.remaining)}
          </div>
        )}
        {!touch && hud.voice === 'on' && (
          <div style={voiceRow}>
            <span className={`dot${hud.talking ? ' on' : ''}`} />
            {hud.talking
              ? 'Talking'
              : `Hold V to talk${hud.hearing ? ` · ${hud.hearing} near` : ''}`}
          </div>
        )}
      </div>
      <div style={{ ...corner, right: 'calc(var(--safe-r) + 32px)', alignItems: 'flex-end' }}>
        <div className="hud-top">
          <div className="glass hud-strip">
            <span className="time">
              <ClockIcon />
              {hud.clock}
            </span>
            <span>
              <BarsIcon />
              {Math.round(game.stats.fps)} FPS
            </span>
            <span style={{ color: pingColour(hud.net, hud.ping) }}>{ping}</span>
          </div>
          {hud.money !== null && (
            <div className="glass hud-cash">
              <CashIcon />
              {formatMoney(hud.money)}
            </div>
          )}
          <UsdcPill game={game} />
        </div>
        <TaskPanel game={game} touch={touch} />
      </div>
      {hud.driving && (
        <Dashboard
          kmh={hud.speedKmh}
          gear={hud.gear}
          fuel={hud.fuel}
          health={hud.carHealth}
          touch={touch}
        />
      )}
      <div className={`door-fade${hud.fading ? ' on' : ''}`} />
      {hud.armed && (
        <Crosshair
          hitAgo={performance.now() - hud.hitAt}
          head={hud.hitHead}
          aiming={hud.aiming}
          onPerson={hud.aimOnPerson}
        />
      )}
      {hud.ammo && (
        <div className={`glass ammo${hud.ammo.mag === 0 ? ' empty' : ''}`}>
          {hud.ammo.reloading ? (
            'Reloading…'
          ) : (
            <>
              <b>{hud.ammo.mag}</b>
              <span>/ {Math.max(0, hud.ammo.total - hud.ammo.mag)}</span>
            </>
          )}
        </div>
      )}
      {performance.now() - hud.hurtAt < 400 && <div style={hurt} />}
      {hud.downed && !hud.inBed && (
        <div style={downedStyle}>
          <div style={{ font: '400 44px/1 var(--font-display)', letterSpacing: 1.5 }}>
            YOU'RE DOWN
          </div>
          <div className="chip glass" style={{ marginTop: 14, color: 'var(--muted)' }}>
            {hud.emsCalled ? 'EMS called · hold on' : 'You will faint soon'} ·{' '}
            {Math.ceil(hud.respawnIn)} s
          </div>
          <div className="down-actions">
            {!hud.emsCalled && (
              <button type="button" className="btn btn-primary" onClick={() => game.callEms()}>
                Call EMS
              </button>
            )}
            <button type="button" className="btn" onClick={() => game.faint()}>
              Faint
            </button>
          </div>
        </div>
      )}
      {hud.inBed && (
        <div className="bed-card glass">
          <b>Healing</b>
          <div className="bed-bar">
            <i style={{ width: `${hud.hp}%` }} />
          </div>
          <small>Ready in {Math.ceil(hud.respawnIn)} s</small>
          <button type="button" className="btn" onClick={() => game.getUp()}>
            Get up now
          </button>
        </div>
      )}
      <Prompt game={game} touch={touch} />
      <RewardToasts game={game} />
      <TutorialCard game={game} touch={touch} />
      <MiningSwing game={game} touch={touch} />
      {(hud.money !== null || PHONE_DEMO) && <Phone game={game} clock={hud.clock} />}
      <Guide game={game} touch={touch} />
      <ParkingSheet game={game} />
      <DealerSheet game={game} />
      <GunStoreSheet game={game} />
      <CounterSheet game={game} />
      <TillSheet game={game} />
      <WalletSheet game={game} />
      <ComputerSheet game={game} />
      <JoinSheet game={game} />
      <DispatchCard game={game} />
      <RideCard game={game} />
      {!touch && (
        <div className="chip glass" style={hints}>
          {(hud.driving
            ? [
                ['W S', 'gas, brake'],
                ['A D', 'steer'],
                ['Space', 'handbrake'],
                ['H', 'horn'],
                ['E', 'exit'],
              ]
            : hud.armed
              ? [
                  ['RMB', 'aim'],
                  ['LMB', 'fire'],
                  ['Q', 'switch'],
                  ['R', 'reload'],
                  ['WASD', 'move'],
                ]
              : [
                  ['WASD', 'move'],
                  ['Space', 'jump'],
                  ['Shift', 'walk'],
                  ['Click', 'punch'],
                  ['G', 'emotes'],
                  ['T', 'chat'],
                  ['P', 'phone'],
                ]
          ).map(([k, label]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="kbd" style={hintKey}>
                {k}
              </span>
              {label}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** "350 m", "1.2 km". */
function formatDistance(m: number): string {
  return m < 1000 ? `${Math.max(1, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Good ping green, middling amber, bad red. The owner's connection is about 180 ms from the
 * Frankfurt server at best and plays fine (2026-10-31), so that's amber: red should mean trouble.
 */
function pingColour(net: string, ping: number): string {
  if (net !== 'online') return 'var(--faint)';
  return ping < 120 ? 'var(--brand)' : ping < 300 ? 'var(--warn)' : 'var(--danger)';
}

/** Under the minimap: their face, name and level, and how far to the next. */
function PlayerCard({ name, xp, portrait }: { name: string; xp: number; portrait: string | null }) {
  const l = levelOf(xp);
  return (
    <div className="glass hud-player">
      {portrait ? (
        <img className="hud-player-face" src={portrait} alt="" />
      ) : (
        <span className="hud-player-face">{name.slice(0, 1).toUpperCase()}</span>
      )}
      <div className="hud-player-text">
        <div className="hud-player-top">
          <em>{name}</em>
          <b className="hud-player-level">{l.level}</b>
        </div>
        <small>
          {l.next ? `XP ${l.into.toLocaleString()} / ${l.next.toLocaleString()}` : 'Top level'}
        </small>
        <span className="track">
          <i style={{ width: `${l.next ? Math.min(100, (l.into / l.next) * 100) : 100}%` }} />
        </span>
      </div>
    </div>
  );
}

/** Brand green while healthy, red when low. */
function HealthBar({ hp, width }: { hp: number; width: number }) {
  const low = hp <= 30;
  return (
    <div style={{ ...healthTrack, width }}>
      <div
        style={{
          width: `${Math.max(0, Math.min(100, hp))}%`,
          height: '100%',
          borderRadius: 3,
          background: low ? 'var(--danger)' : 'var(--brand)',
          boxShadow: low ? 'none' : '0 0 8px var(--brand-glow)',
          transition: 'width 200ms ease-out',
        }}
      />
    </div>
  );
}

/** Centre crosshair; red over a person; flashes into an X on a confirmed hit (red for the head). */
function Crosshair({
  hitAgo,
  head,
  aiming,
  onPerson,
}: {
  hitAgo: number;
  head: boolean;
  aiming: boolean;
  onPerson: boolean;
}) {
  const hit = hitAgo < 220;
  const size = aiming ? 16 : 22;
  const colour =
    (hit && head) || onPerson ? 'var(--danger)' : hit ? '#ffffff' : 'rgba(255,255,255,0.9)';
  const line = (rot: number): CSSProperties => ({
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 2,
    height: size / 2,
    borderRadius: 1,
    background: colour,
    transformOrigin: '50% 0',
    transform: `translate(-50%, 0) rotate(${rot}deg) translateY(${hit ? 3 : 4}px)`,
    boxShadow: '0 0 3px rgba(0,0,0,0.7)',
  });
  const angles = hit ? [45, 135, 225, 315] : [0, 90, 180, 270];
  return (
    <div style={{ position: 'fixed', left: '50%', top: '50%', pointerEvents: 'none' }}>
      {angles.map((a) => (
        <div key={a} style={line(a)} />
      ))}
    </div>
  );
}

const corner: CSSProperties = {
  position: 'fixed',
  top: 'var(--safe-t)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  pointerEvents: 'none',
};
const voiceRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--muted)',
  font: '600 11px/1 var(--font)',
};
const healthTrack: CSSProperties = {
  height: 5,
  borderRadius: 3,
  background: 'rgba(255,255,255,0.14)',
  overflow: 'hidden',
};
const hurt: CSSProperties = {
  position: 'fixed',
  inset: 0,
  boxShadow: 'inset 0 0 120px 30px rgba(200, 20, 20, 0.5)',
  pointerEvents: 'none',
};
const downedStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'radial-gradient(circle, rgba(40,0,0,0.1), rgba(20,0,0,0.6))',
  color: 'var(--ink)',
  textShadow: '0 2px 14px rgba(0,0,0,0.8)',
  pointerEvents: 'none',
};
const hints: CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 'var(--safe-b)',
  transform: 'translateX(-50%)',
  gap: 16,
  padding: '6px 14px 6px 6px',
  color: 'var(--muted)',
  fontWeight: 600,
  fontSize: 12,
  whiteSpace: 'nowrap',
};
const hintKey: CSSProperties = {
  height: 20,
  background: 'rgba(255,255,255,0.14)',
  color: 'var(--ink)',
  fontSize: 10,
};
