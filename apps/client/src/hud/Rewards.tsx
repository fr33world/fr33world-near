/**
 * The phone's Rewards app (shared daily.ts): today's login, the free spin, the day's tasks and
 * level bonuses. The server decides everything: a claim's answer is what's shown, and the wheel
 * only turns to the prize it already rolled.
 */
import { DAILY_TASKS, levelPrize, LOGIN_STREAK, type Prize, SPIN } from '@fr33world/shared';
import { useCallback, useEffect, useState } from 'react';
import type { DailyStatus } from '../game/api.ts';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

const SLICE = 360 / SPIN.length;
const SHADES = ['#27313c', '#1d252e'];

/** How many things are waiting to be claimed. */
export function waiting(s: DailyStatus): number {
  const tasks = s.tasks.filter((t) => {
    const need = DAILY_TASKS.find((d) => d.id === t.id)?.need ?? Infinity;
    return !t.claimed && t.done >= need;
  });
  return (s.login.claimed ? 0 : 1) + (s.spin.claimed ? 0 : 1) + tasks.length + s.levels.length;
}

function what(p: { cents?: number; xp?: number; item?: string; label?: string }): string {
  const parts = [
    p.cents ? formatMoney(p.cents) : null,
    p.xp ? `${p.xp} XP` : null,
    p.item ? p.item[0]?.toUpperCase() + p.item.slice(1) : null,
  ];
  return parts.filter(Boolean).join(' + ') || (p.label ?? '');
}

function Wheel({ turn, spinning }: { turn: number; spinning: boolean }) {
  const stops = SPIN.map((_, i) => `${SHADES[i % 2]} ${i * SLICE}deg ${(i + 1) * SLICE}deg`).join(
    ', ',
  );
  return (
    <div className="wheel-frame">
      <i className="wheel-pointer" />
      <div
        className={`wheel${spinning ? ' spinning' : ''}`}
        style={{ background: `conic-gradient(${stops})`, transform: `rotate(${turn}deg)` }}
      >
        {SPIN.map((s, i) => (
          <span key={s.label} style={{ transform: `rotate(${(i + 0.5) * SLICE}deg)` }}>
            <b>{s.label}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function RewardsApp({ game }: { game: Game }) {
  const [s, setS] = useState<DailyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turn, setTurn] = useState(0);
  const [spinning, setSpinning] = useState(false);

  const load = useCallback(() => {
    void game.daily().then(setS, (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [game]);
  useEffect(load, [load]);

  const claim = (body: { what: string; level?: number }) => {
    setBusy(true);
    setError(null);
    return game.claimDaily(body).then(
      (r) => {
        setBusy(false);
        return r;
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
        return null;
      },
    );
  };
  const take = (body: { what: string; level?: number }) =>
    void claim(body).then((r) => {
      if (r) setSaid(`You got ${what(r)}.`);
      load();
    });
  const spin = () =>
    void claim({ what: 'spin' }).then((r) => {
      if (!r) return;
      // Round a few times, landing the prize's slice under the pointer at the top.
      setSpinning(true);
      setTurn(360 * 5 - ((r.slice ?? 0) + 0.5) * SLICE);
      window.setTimeout(() => {
        setSpinning(false);
        setSaid(`You won ${what(r)}!`);
        load();
      }, 3200);
    });

  if (error && !s) return <div className="login-error">{error}</div>;
  if (!s) return <div className="bank-sub">Opening…</div>;
  return (
    <div className="bank rewards">
      {said && <div className="rewards-said">{said}</div>}
      {error && <div className="login-error">{error}</div>}

      <div className="bank-title">Daily login</div>
      <div className="streak">
        {LOGIN_STREAK.map((p: Prize, i) => {
          const day = i + 1;
          const done = day < s.login.streak || (day === s.login.streak && s.login.claimed);
          return (
            <div
              key={day}
              className={`streak-day${done ? ' done' : ''}${day === s.login.streak && !s.login.claimed ? ' now' : ''}`}
            >
              <small>Day {day}</small>
              <b>{done ? '✓' : p.label}</b>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={s.login.claimed || busy}
        onClick={() => take({ what: 'login' })}
      >
        {s.login.claimed ? 'Come back tomorrow' : `Claim day ${s.login.streak}`}
      </button>

      <div className="bank-title">Free spin</div>
      <Wheel turn={turn} spinning={spinning} />
      <button
        type="button"
        className="btn btn-primary"
        disabled={s.spin.claimed || busy || spinning}
        onClick={spin}
      >
        {s.spin.claimed ? 'One spin a day' : 'Spin'}
      </button>

      <div className="bank-title">Today’s tasks</div>
      {DAILY_TASKS.map((t) => {
        const now = s.tasks.find((x) => x.id === t.id);
        const done = now?.done ?? 0;
        const ready = done >= t.need && !now?.claimed;
        return (
          <div key={t.id} className="bank-row">
            <span className="bank-what">
              <b>{t.name}</b>
              <small>
                {now?.claimed
                  ? 'Done'
                  : t.id === 'earn'
                    ? `${formatMoney(done)} of ${formatMoney(t.need)}`
                    : `${done} of ${t.need}`}{' '}
                · {t.prize.label}
              </small>
            </span>
            {ready && (
              <button
                type="button"
                className="btn btn-primary task-claim"
                disabled={busy}
                onClick={() => take({ what: t.id })}
              >
                Claim
              </button>
            )}
          </div>
        );
      })}

      {s.levels.length > 0 && <div className="bank-title">Level bonuses</div>}
      {s.levels.map((l) => (
        <div key={l} className="bank-row">
          <span className="bank-what">
            <b>Level {l}</b>
            <small>{levelPrize(l).label}</small>
          </span>
          <button
            type="button"
            className="btn btn-primary task-claim"
            disabled={busy}
            onClick={() => take({ what: 'level', level: l })}
          >
            Claim
          </button>
        </div>
      ))}
    </div>
  );
}
