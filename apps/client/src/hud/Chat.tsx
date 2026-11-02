/**
 * Proximity text chat (Phase 4): lines said within 30 m. The feed sits at the top middle
 * (after OneState's layout), the latest lines fading after a while unless the chat is open;
 * open it with Enter or T on a keyboard, or the chat button on touch, and Enter sends. Each
 * line also shows as a bubble over the speaker's head for a few seconds.
 */
import { CHAT } from '@fr33world/protocol';
import { useEffect, useRef, useState } from 'react';
import type { Game } from '../game/Game.ts';
import { isTouchDevice } from '../game/quality.ts';

/** How long a line stays in the closed feed (ms), and how many show. */
const FEED_MS = 12_000;
const FEED_LINES = 6;

export function Chat({ game, online }: { game: Game; online: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const touch = isTouchDevice();
  const now = performance.now();
  const lines = game.chat.slice(open ? -FEED_LINES * 2 : -FEED_LINES);
  const shown = open ? lines : lines.filter((l) => now - l.at < FEED_MS);

  // Enter or T opens the chat (when the game has the keyboard).
  useEffect(() => {
    if (!online) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (open || target?.tagName === 'INPUT') return;
      if (e.code === 'Enter' || e.code === 'KeyT') {
        e.preventDefault();
        if (document.pointerLockElement) void document.exitPointerLock();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, online]);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const send = () => {
    game.say(draft);
    setDraft('');
    setOpen(false);
  };

  return (
    <>
      <div className={`chat${open ? ' open' : ''}`}>
        {shown.length > 0 && (
          <div className="chat-feed">
            {shown.map((l) => (
              <div
                key={l.key}
                className={`chat-line${l.you ? ' you' : ''}${l.system ? ' system' : ''}`}
                style={{ opacity: open ? 1 : Math.min(1, (FEED_MS - (now - l.at)) / 2000) }}
              >
                {l.system ? (
                  l.text
                ) : (
                  <>
                    <b>{l.name}</b> {l.text}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {open && (
          <form
            className="chat-input glass"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              ref={field}
              value={draft}
              maxLength={CHAT.MAX_CHARS}
              enterKeyHint="send"
              placeholder="Say something nearby, or /help"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft('');
                  setOpen(false);
                }
              }}
              onBlur={() => !draft && setOpen(false)}
            />
            <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
              Send
            </button>
          </form>
        )}
      </div>
      {online && touch && !open && (
        <button
          type="button"
          className="tbtn glass chat-button"
          aria-label="Chat"
          onClick={() => setOpen(true)}
        >
          <ChatIcon />
        </button>
      )}
      <Bubbles game={game} />
    </>
  );
}

/** Speech bubbles over speakers' heads, moved every frame (not through React). */
function Bubbles({ game }: { game: Game }) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const nodes = new Map<number, HTMLDivElement>();
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const list = game.speechBubbles(window.innerWidth, window.innerHeight);
      const seen = new Set<number>();
      for (const b of list) {
        seen.add(b.key);
        let n = nodes.get(b.key);
        if (!n) {
          n = document.createElement('div');
          n.className = 'bubble';
          el.appendChild(n);
          nodes.set(b.key, n);
        }
        if (n.textContent !== b.text) n.textContent = b.text;
        n.style.transform = `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px) translate(-50%, -100%)`;
      }
      for (const [k, n] of nodes) {
        if (!seen.has(k)) {
          n.remove();
          nodes.delete(k);
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [game]);
  return <div ref={layer} className="bubbles" />;
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}
