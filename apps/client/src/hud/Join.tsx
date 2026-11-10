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
import { Modal, type Medal } from '../ui/Modal.tsx';

const MEDALS: Record<FactionId, Medal> = {
  police: 'police',
  medical: 'ems',
  vipers: 'vipers',
  kings: 'kings',
};

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
  const canApply = s && step === 0 && !elsewhere && !applying;
  return (
    <Modal
      title={f.name}
      subtitle={guide.tagline}
      accent={f.colour}
      art={`/ui/medals/${MEDALS[faction]}.webp`}
      rail={
        <ul className="m-perks">
          {guide.perks.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      }
      footer={
        <>
          {canApply && (
            <input
              className="m-input"
              maxLength={200}
              placeholder="Why? (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          {canApply && (
            <button type="button" className="m-btn go" disabled={busy} onClick={apply}>
              {busy ? 'Sending…' : 'Apply'}
            </button>
          )}
          {step === 1 && (
            <button type="button" className="m-btn go" onClick={toPhone}>
              Start training
            </button>
          )}
        </>
      }
      onClose={close}
    >
      {guide.door && <p className="m-callout">{guide.door}</p>}
      <ol className="m-steps">
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
      {elsewhere && <p className="m-empty">Leave the {FACTIONS[elsewhere.faction].short} first.</p>}
      {applying && (
        <p className="m-empty">Already applying to the {FACTIONS[applying.faction].short}.</p>
      )}
      {step === 2 && (
        <p className="m-empty">
          {s?.application?.interviewAt
            ? `Interview: ${new Date(s.application.interviewAt).toLocaleString([], {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}`
            : 'Passed. Waiting for an interview.'}
        </p>
      )}
      {step === 3 && <p className="m-empty">You’re a member</p>}
    </Modal>
  );
}
