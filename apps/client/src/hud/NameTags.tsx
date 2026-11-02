/**
 * Name tags (Phase 4): each player within 25 m has their character's name and level over their
 * head, fading out with distance, with a mic when they're talking. Tapping one (or clicking it with
 * the mouse free) opens their card: wave at them, mute their voice for the session, and
 * (logged in) block them for good (no chat, voice or tag from them) or report them.
 * Positions are moved every frame outside React.
 */
import { FACTIONS } from '@fr33world/shared';
import { useEffect, useRef, useState } from 'react';
import { REPORT_REASONS } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

export function NameTags({ game }: { game: Game }) {
  const layer = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const nodes = new Map<number, HTMLButtonElement>();
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const seen = new Set<number>();
      for (const t of game.nameTags(window.innerWidth, window.innerHeight)) {
        seen.add(t.id);
        let n = nodes.get(t.id);
        if (!n) {
          n = document.createElement('button');
          n.type = 'button';
          n.className = 'name-tag';
          n.append(document.createElement('span'), document.createElement('b'));
          const id = t.id;
          n.addEventListener('click', () => setCard({ id, name: n?.dataset.name ?? '' }));
          el.appendChild(n);
          nodes.set(t.id, n);
        }
        // A faction member's tag wears its colour and short name.
        const f = t.faction ? FACTIONS[t.faction] : null;
        const label = `${t.talking ? '🎙 ' : ''}${f ? `${f.short} · ` : ''}${t.name}`;
        const [text, level] = n.children as unknown as [HTMLElement, HTMLElement];
        const lv = t.level ? `LV ${t.level}` : '';
        if (text.textContent !== label || level.textContent !== lv) {
          text.textContent = label;
          level.textContent = lv;
          n.dataset.name = t.name;
          n.style.borderColor = f ? f.colour : '';
          n.style.color = f ? f.colour : '';
        }
        n.classList.toggle('talking', t.talking);
        n.classList.toggle('muted', game.isMuted(t.id));
        n.style.opacity = t.alpha.toFixed(2);
        n.style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -100%)`;
      }
      for (const [id, n] of nodes) {
        if (!seen.has(id)) {
          n.remove();
          nodes.delete(id);
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [game]);

  return (
    <>
      <div ref={layer} className="name-tags" />
      {card && <PlayerCard game={game} who={card} onClose={() => setCard(null)} />}
    </>
  );
}

/** A player's card: who they are, and what you can do about them. */
function PlayerCard({
  game,
  who,
  onClose,
}: {
  game: Game;
  who: { id: number; name: string };
  onClose: () => void;
}) {
  const [muted, setMuted] = useState(game.isMuted(who.id));
  const [blocked, setBlocked] = useState(game.isBlocked(who.name));
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggleBlock = () => {
    setBusy(true);
    setNote(null);
    game.block(who.name, !blocked).then(
      () => {
        setBlocked(!blocked);
        setBusy(false);
        setNote(blocked ? `${who.name} is unblocked.` : `You won't see or hear ${who.name}.`);
      },
      (e: unknown) => {
        setBusy(false);
        setNote(e instanceof Error ? e.message : String(e));
      },
    );
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet glass player-card" onClick={(e) => e.stopPropagation()}>
        <div className="player-card-name">{who.name}</div>
        <div className="sheet-note">In Los Soles · nearby</div>
        {reporting ? (
          <ReportForm
            game={game}
            name={who.name}
            onDone={(message) => {
              setReporting(false);
              setNote(message);
            }}
          />
        ) : (
          <div className="player-card-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                game.emote(0);
                onClose();
              }}
            >
              Wave
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                game.setMuted(who.id, !muted);
                setMuted(!muted);
              }}
            >
              {muted ? 'Unmute' : 'Mute'}
            </button>
            {game.canModerate && (
              <>
                <button type="button" className="btn" disabled={busy} onClick={toggleBlock}>
                  {blocked ? 'Unblock' : 'Block'}
                </button>
                <button type="button" className="btn danger" onClick={() => setReporting(true)}>
                  Report
                </button>
              </>
            )}
          </div>
        )}
        {note && <div className="login-fine">{note}</div>}
        <button type="button" className="btn btn-link" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Why they're being reported, and anything to add. */
function ReportForm({
  game,
  name,
  onDone,
}: {
  game: Game;
  name: string;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="report"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason) return;
        setBusy(true);
        game.report(name, reason, details).then(
          () => onDone(`Thanks. ${name} has been reported; the team will look into it.`),
          (err: unknown) => {
            setBusy(false);
            setError(err instanceof Error ? err.message : String(err));
          },
        );
      }}
    >
      <div className="chips">
        {REPORT_REASONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={reason === value ? 'on' : ''}
            onClick={() => setReason(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        value={details}
        maxLength={500}
        rows={3}
        placeholder="What happened? (optional)"
        onChange={(e) => setDetails(e.target.value)}
      />
      {error && <div className="login-error">{error}</div>}
      <button type="submit" className="btn btn-primary" disabled={!reason || busy}>
        {busy ? 'Sending…' : 'Send report'}
      </button>
    </form>
  );
}
