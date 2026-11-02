/**
 * The dispatch (Phase 9): for police and medics on duty, the open calls (911 calls, people down,
 * shots fired), newest first, under the money. "Go" marks the place on the map and tells the
 * caller help is coming (/respond); the tick closes a call that's dealt with (/resolve).
 */
import type { Game } from '../game/Game.ts';

export function DispatchCard({ game }: { game: Game }) {
  const duty = game.duty;
  if (!duty || game.dispatch.length === 0) return null;
  const calls = [...game.dispatch].sort((a, b) => b.id - a.id).slice(0, 3);
  return (
    <div className={`glass dispatch ${duty}`}>
      <div className="dispatch-head">{duty === 'police' ? '🚓 Dispatch' : '🚑 Dispatch'}</div>
      {calls.map((c) => (
        <div key={c.id} className="dispatch-call">
          <span className="dispatch-text">
            <b>{c.text}</b>
            <small>
              {c.minutes ? `${c.minutes} min ago` : 'just now'}
              {c.responders.length ? ` · ${c.responders.join(', ')} going` : ''}
            </small>
          </span>
          <button
            type="button"
            className="dispatch-go"
            onClick={() => {
              game.waypoints.set({ x: c.x, z: c.z, label: `Call ${c.id}`, by: 'map' });
              game.command(`/respond ${c.id}`);
            }}
          >
            Go
          </button>
          <button
            type="button"
            className="dispatch-done"
            aria-label="Close call"
            onClick={() => game.command(`/resolve ${c.id}`)}
          >
            ✓
          </button>
        </div>
      ))}
    </div>
  );
}
