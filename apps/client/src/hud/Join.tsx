/**
 * The join point (owner's launch-eve list): in the Police Station and the Hospital, a board by
 * the door; at a gang's house, the shut door itself. Says who they are, what you get and the
 * steps, marks how far you've got, and starts the application there and then. Training still
 * happens in the phone's Faction app, which the button opens.
 */
import { FACTION_GUIDE, type FactionId, FACTIONS, JOIN_STEPS } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import type { FactionStatus } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

/** Which of JOIN_STEPS the player is on for this faction: 0 to apply, 3 once in. */
export function joinStep(s: FactionStatus | null, faction: FactionId): number {
  if (s?.membership?.faction === faction) return 3;
  if (s?.application?.faction !== faction) return 0;
  return s.application.stage === 'interview' ? 2 : 1;
}

export function JoinSheet({ game }: { game: Game }) {
  const [faction, setFaction] = useState<FactionId | null>(null);
  const [s, setS] = useState<FactionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    game.onJoin = (f) => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setFaction(f);
      setS(null);
      setError(null);
      setNote('');
      void game.factions().then(setS, (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    };
    return () => {
      game.onJoin = () => {};
    };
  }, [game]);
  useEffect(() => {
    if (!faction) return;
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setFaction(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [faction]);

  if (!faction) return null;
  const f = FACTIONS[faction];
  const guide = FACTION_GUIDE[faction];
  const step = joinStep(s, faction);
  const elsewhere = s?.membership && s.membership.faction !== faction ? s.membership : null;
  const applying = s?.application && s.application.faction !== faction ? s.application : null;
  const close = () => setFaction(null);
  const apply = () => {
    setBusy(true);
    void game.applyFaction(faction, note).then(
      (r) => {
        setS(r);
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };
  const toPhone = () => {
    close();
    game.onPhone('faction');
  };
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet glass guide join-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="gun-badge" style={{ color: f.colour, borderColor: f.colour }}>
            {f.short.slice(0, 1)}
          </span>
          <div>
            <div className="sheet-title">{f.name}</div>
            <div className="sheet-note">{guide.tagline}</div>
          </div>
        </div>
        <div className="join-scroll">
          {guide.door && <p className="join-door">{guide.door}</p>}
          <p className="join-about">{guide.about}</p>
          <ul className="join-perks">
            {guide.perks.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="join-title">How to join</div>
          <ol className="join-steps">
            {JOIN_STEPS.map((j, i) => (
              <li key={j.title} className={i < step ? 'done' : i === step ? 'now' : ''}>
                <i>{i < step ? '✓' : i + 1}</i>
                <span>
                  <b>{j.title}</b>
                  <small>{j.text}</small>
                </span>
              </li>
            ))}
          </ol>
          {error && <div className="login-error">{error}</div>}
          {elsewhere && (
            <div className="sheet-note">
              You’re in the {FACTIONS[elsewhere.faction].name}. Leave them first, in the phone’s
              Faction app.
            </div>
          )}
          {applying && (
            <div className="sheet-note">
              You’ve applied to the {FACTIONS[applying.faction].name}. Finish or withdraw that
              first.
            </div>
          )}
          {s && step === 0 && !elsewhere && !applying && (
            <input
              className="field"
              maxLength={200}
              placeholder="Why do you want in? (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          {step === 2 && (
            <div className="sheet-note">
              {s?.application?.interviewAt
                ? `Your interview: ${new Date(s.application.interviewAt).toLocaleString([], {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}. Be here.`
                : 'You passed. A boss will set your interview, and your phone will tell you.'}
            </div>
          )}
          {step === 3 && <div className="sheet-note">You’re a member.</div>}
        </div>
        <div className="join-actions">
          {s && step === 0 && !elsewhere && !applying && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={apply}>
              {busy ? 'Sending…' : `Apply to ${f.short}`}
            </button>
          )}
          {step === 1 && (
            <button type="button" className="btn btn-primary" onClick={toPhone}>
              Start training
            </button>
          )}
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
