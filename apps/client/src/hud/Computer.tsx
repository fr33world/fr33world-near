/**
 * The computer in a faction's building (owner, 2026-10-31): who has applied, and for a boss the
 * way to set an interview, then to take them on or turn them down. Bosses of a faction see its
 * applications; the city's overall boss sees all of them. The world server does the deciding
 * (chat commands), so anyone online hears at once.
 */
import { FACTIONS } from '@fr33world/shared';
import { useCallback, useEffect, useState } from 'react';
import type { FactionDesk } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { Modal, Said } from '../ui/Modal.tsx';

const WHEN: [string, number][] = [
  ['15 min', 15],
  ['1 hour', 60],
  ['Tonight', 240],
  ['Tomorrow', 1440],
];

export function ComputerSheet({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [desk, setDesk] = useState<FactionDesk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(() => {
    void game.desk().then(
      (d) => {
        setDesk(d);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [game]);
  useEffect(() => {
    game.onComputer = () => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setSaid(null);
      setDesk(null);
      setOpen(true);
      load();
    };
    return () => {
      game.onComputer = () => {};
    };
  }, [game, load]);

  if (!open) return null;
  const cmd = (text: string, done: string) => {
    setSaid(game.command(text) ? done : "You're offline.");
    window.setTimeout(load, 1200);
  };
  return (
    <Modal
      title="Applications"
      accent="#7fb0ff"
      art="/ui/medals/desk.webp"
      onClose={() => setOpen(false)}
    >
      {error && <div className="login-error">{error}</div>}
      {!desk && !error && <p className="m-empty">Opening…</p>}
      {desk?.factions.length === 0 && <p className="m-empty">Sergeants and above</p>}
      {desk?.factions.length !== 0 && desk?.applicants.length === 0 && (
        <p className="m-empty">No applications</p>
      )}
      {desk?.applicants.map((a) => (
        <div key={a.name} className="m-person">
          <span className="m-avatar">{a.name.slice(0, 1).toUpperCase()}</span>
          <div className="m-row-text">
            <b>{a.name}</b>
            <small>
              {FACTIONS[a.faction].short} ·{' '}
              {a.stage === 'training'
                ? 'In training'
                : a.interviewAt
                  ? `Interview ${new Date(a.interviewAt).toLocaleString([], {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}`
                  : 'Passed training'}
              {a.note ? ` · “${a.note}”` : ''}
            </small>
            {a.stage === 'interview' && (
              <div className="m-actions">
                {WHEN.map(([label, minutes]) => (
                  <button
                    key={label}
                    type="button"
                    className="m-btn small"
                    onClick={() =>
                      cmd(`/interview "${a.name}" ${minutes}`, `${a.name}: interview set.`)
                    }
                  >
                    {label}
                  </button>
                ))}
                {a.interviewAt && (
                  <>
                    <button
                      type="button"
                      className="m-btn small go"
                      onClick={() => cmd(`/accept "${a.name}"`, `${a.name}: accepted.`)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="m-btn small danger"
                      onClick={() => cmd(`/reject "${a.name}"`, `${a.name}: turned down.`)}
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      <Said text={said} />
    </Modal>
  );
}
