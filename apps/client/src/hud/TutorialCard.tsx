/**
 * The tutorial's dialogue (PRD §5.1; owner, 2026-10-30): a long strip at the bottom, out of the
 * way of the controls (only its buttons take touches: the stick and the look pad work through
 * it), with Luz cut out standing over its corner, her tag, the step as pips, what she says
 * (always readable: nothing depends on sound) and her button where a step needs one. A long
 * step (the first delivery) can be skipped on its own; the whole tutorial at any time.
 */
import { TUTORIAL_STEPS } from '@fr33world/shared';
import type { Game } from '../game/Game.ts';

export function TutorialCard({ game, touch }: { game: Game; touch: boolean }) {
  const t = game.tutorial;
  if (!t || t.over) return null;
  const lesson = t.lesson;
  const total = TUTORIAL_STEPS.length - 1;
  return (
    <div className={`tutorial${touch ? ' touch' : ''}`}>
      {/* Luz, cut out, standing over the panel's corner (public/ui/tutorial/luz.webp). */}
      <img className="tutorial-luz" src="/ui/tutorial/luz.webp" alt="" draggable={false} />
      <div className="tutorial-panel">
        <div className="tutorial-head">
          <span className="tutorial-tag">{touch ? 'Luz' : 'Luz · City guide'}</span>
          <span
            className="tutorial-pips"
            aria-label={`Step ${Math.min(t.number, total)} of ${total}`}
          >
            {Array.from({ length: total }, (_, i) => (
              <i key={i} className={i < t.number - 1 ? 'done' : i === t.number - 1 ? 'now' : ''} />
            ))}
          </span>
        </div>
        <p>{lesson.say(touch)}</p>
        <div className="tutorial-actions">
          {lesson.button && (
            <button type="button" className="btn btn-primary" onClick={() => t.next()}>
              {lesson.button}
            </button>
          )}
          {lesson.skippable && (
            <button type="button" className="btn" onClick={() => t.next()}>
              Skip step
            </button>
          )}
          {t.step !== 'done' && (
            <button type="button" className="btn btn-link" onClick={() => t.skip()}>
              Skip tutorial
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
