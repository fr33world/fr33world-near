/**
 * Jobs on the HUD (Phase 6): the task panel (the shift, what to do now, deliveries or ore,
 * the time left and what it has earned, and Quit), reward toasts (money and XP, a level-up),
 * and the mining swing: a marker sweeps a bar, and a press (E, Space or a tap) while it's in
 * the green lands a strike; a miss costs a moment. The server only counts a strike so often,
 * so the swing is about feel, not a way past the rules.
 */
import { titleOf } from '@fr33world/shared';
import { useEffect, useRef, useState } from 'react';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

export function TaskPanel({ game }: { game: Game; touch: boolean }) {
  const job = game.job;
  if (!job) return null;
  // A shift lasts minutes: anything past a day is a server still sending wall-clock time.
  const raw = job.endsAt ? Math.max(0, job.endsAt - game.serverNow()) : null;
  const left = raw !== null && raw < 86_400_000 ? raw : null;
  const clock =
    left === null
      ? ''
      : `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  // The last two minutes: red and pulsing, as the server's warning says.
  const ending = left !== null && left < 120_000;
  const meta = [
    job.progress ? `${job.progress.label} ${job.progress.done}/${job.progress.total}` : null,
    job.cargo
      ? `${job.cargo.label} ${job.cargo.count}${job.cargo.max ? `/${job.cargo.max}` : ''}`
      : null,
  ].filter(Boolean);
  return (
    <div className="task glass">
      <span className={`task-pic ${job.job}`}>
        <JobPicture job={job.job} />
      </span>
      <div className="task-body">
        <div className="task-title">
          {job.title.split(' · ')[0]}
          <span className="task-earned">
            {formatMoney(job.earned.cents)} · {job.earned.xp} XP
          </span>
        </div>
        <div className="task-step">{job.step}</div>
        <div className="task-meta">
          {meta.join(' · ')}
          {left !== null && <b className={ending ? 'ending' : ''}>⏱ {clock}</b>}
        </div>
      </div>
      <button
        type="button"
        className="task-quit"
        aria-label="Quit shift"
        onClick={() => game.quitJob()}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * A small picture for each job: a parcel for the courier, a pickaxe on ore for mining, a cab
 * for the taxi, a bag of takings for collections.
 */
function JobPicture({ job }: { job: string }) {
  if (job === 'taxi')
    return (
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M6 25v-5l4-8h20l4 8v5z" fill="#f2c230" />
        <rect x="16" y="8" width="8" height="4" rx="1" fill="#1d1600" />
        <path d="M11 13h18l3 6H8z" fill="#2a2f38" />
        <circle cx="12" cy="26" r="3.5" fill="#1d1600" />
        <circle cx="28" cy="26" r="3.5" fill="#1d1600" />
      </svg>
    );
  if (job === 'collect')
    return (
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M13 13c-5 4-7 9-6 14 1 4 6 6 13 6s12-2 13-6c1-5-1-10-6-14z" fill="#7a6a4a" />
        <path d="M14 13l3-5h6l3 5" fill="#5a4c32" />
        <text x="20" y="28" textAnchor="middle" fontSize="11" fontWeight="800" fill="#e8d9a8">
          $
        </text>
      </svg>
    );
  if (job === 'mining')
    return (
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M6 30l8-12 7 6 6-9 7 15z" fill="#6b5a4a" />
        <path d="M14 18l3 3-3 2z M27 15l2 4-3 1z" fill="#e8b04a" />
        <path
          d="M11 9c6-4 14-4 20 1"
          stroke="#cfd6dd"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
        <path d="M21 8l-6 22" stroke="#9a6b3c" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M8 14l12-6 12 6v13l-12 6-12-6z" fill="#c8924f" />
      <path d="M8 14l12 6 12-6M20 20v13" stroke="#8a5f2c" strokeWidth="1.6" fill="none" />
      <path d="M14 11l12 6" stroke="#f3e2c4" strokeWidth="2.4" />
      <rect x="22" y="22" width="7" height="4" rx="1" fill="#f3e2c4" />
    </svg>
  );
}

const TOAST_MS = 3500;

export function RewardToasts({ game }: { game: Game }) {
  const now = performance.now();
  const shown = game.rewards.filter((r) => now - r.at < TOAST_MS).slice(-3);
  if (shown.length === 0) return null;
  return (
    <div className="toasts">
      {shown.map((r) => (
        <div key={r.key} className="toast glass">
          {r.levelUp !== null && (
            <div className="toast-level">
              LEVEL {r.levelUp}
              <small>{titleOf(r.levelUp)}</small>
            </div>
          )}
          <div className="toast-line">
            {r.cents > 0 && <b className="cash">+{formatMoney(r.cents)}</b>}
            {r.xp > 0 && <b className="xp">+{r.xp} XP</b>}
          </div>
          <small>{r.reason}</small>
        </div>
      ))}
    </div>
  );
}

/** The swing: where the green zone is (0–1) and how wide; the marker's speed (sweeps/s). */
const ZONE = 0.18;
const SPEED = 0.85;
const MISS_MS = 600;

export function MiningSwing({ game, touch }: { game: Game; touch: boolean }) {
  const [point, setPoint] = useState<number | null>(null);
  const [zone, setZone] = useState(0.5);
  const [result, setResult] = useState<'hit' | 'miss' | null>(null);
  const marker = useRef<HTMLDivElement>(null);
  const phase = useRef(0);
  const lockedUntil = useRef(0);
  const swingNow = useRef<() => void>(() => {});

  useEffect(() => {
    game.onTiming = (p) => {
      setPoint(p);
      setZone(0.25 + Math.random() * 0.5);
    };
    return () => {
      game.onTiming = () => {};
    };
  }, [game]);

  // The marker sweeps back and forth; out of reach or off the job, the swing closes.
  useEffect(() => {
    if (point === null) return;
    let frame = 0;
    let last = performance.now();
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      phase.current = (phase.current + ((t - last) / 1000) * SPEED * 2) % 2;
      last = t;
      const x = phase.current < 1 ? phase.current : 2 - phase.current;
      if (marker.current) marker.current.style.left = `${x * 100}%`;
      const p = game.layout.points[point];
      const at = game.whereabouts();
      const still = game.job?.actions.some((a) => a.point === point && a.timing);
      if (!p || !at || !still || Math.hypot(p.x - at.x, p.z - at.z) > p.radius + 1.5)
        setPoint(null);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [game, point]);

  useEffect(() => {
    if (point === null) return;
    const swing = () => {
      const now = performance.now();
      if (now < lockedUntil.current) return;
      const x = phase.current < 1 ? phase.current : 2 - phase.current;
      if (Math.abs(x - zone) <= ZONE / 2) {
        game.strike(point);
        setResult('hit');
        setZone(0.2 + Math.random() * 0.6);
        lockedUntil.current = now + 720;
      } else {
        setResult('miss');
        lockedUntil.current = now + MISS_MS;
      }
      window.setTimeout(() => setResult(null), 400);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'KeyF') {
        e.preventDefault();
        swing();
      } else if (e.code === 'Escape') setPoint(null);
    };
    swingNow.current = swing;
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [game, point, zone]);

  if (point === null) return null;
  const progress = game.job?.progress;
  return (
    <div className="swing glass">
      <div className="swing-title">
        {game.layout.points[point]?.name ?? 'Ore'}
        {progress && (
          <span>
            {progress.done}/{progress.total}
          </span>
        )}
      </div>
      <div className="swing-bar">
        <div
          className="swing-zone"
          style={{ left: `${(zone - ZONE / 2) * 100}%`, width: `${ZONE * 100}%` }}
        />
        <div ref={marker} className={`swing-marker${result ? ` ${result}` : ''}`} />
      </div>
      <button
        type="button"
        className="btn btn-primary swing-button"
        onPointerDown={(e) => {
          e.preventDefault();
          swingNow.current();
        }}
      >
        {result === 'miss' ? 'Missed' : touch ? 'Swing' : 'Swing (E)'}
      </button>
      <button type="button" className="btn btn-link" onClick={() => setPoint(null)}>
        Stop
      </button>
    </div>
  );
}
