/**
 * The phone's Messages app: people you've talked to, and a thread with each. Private, by
 * character name, through the API (messages.ts). A thread asks for news every few seconds while
 * it's open; the phone's badge counts what's unread. Block and report sit in the thread's header.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, DirectMessage } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

const REFRESH_MS = 4000;

const stamp = (at: string) => {
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { timeStyle: 'short' } : { dateStyle: 'short' });
};

function Thread({ game, name, onBack }: { game: Game; name: string; onBack: () => void }) {
  const [messages, setMessages] = useState<DirectMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void game.thread(name).then(
      (t) => setMessages(t.messages),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [game, name]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);
  const count = messages?.length ?? 0;
  // Only the list scrolls: scrollIntoView would move the whole game page too.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [count]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setError(null);
    void game.sendMessage(name, text).then(load, (e: unknown) => {
      setDraft(text);
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div className="dm">
      <div className="dm-head">
        <button type="button" className="dm-back" aria-label="Back" onClick={onBack}>
          ‹
        </button>
        <b>{name}</b>
        <button
          type="button"
          className="dm-back"
          aria-label="More"
          onClick={() => setMenu((m) => !m)}
        >
          ⋯
        </button>
      </div>
      {menu && (
        <div className="dm-menu">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void game.block(name, true).then(() => {
                setMenu(false);
                setSaid(`${name} is blocked.`);
              });
            }}
          >
            Block
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void game.report(name, 'harassment', 'From Messages').then(() => {
                setMenu(false);
                setSaid('Reported. Thank you.');
              });
            }}
          >
            Report
          </button>
        </div>
      )}
      {said && <div className="bank-sub">{said}</div>}
      <div ref={list} className="dm-list">
        {messages?.length === 0 && <div className="bank-empty">Say hello.</div>}
        {messages?.map((m) => (
          <div key={m.id} className={`dm-bubble${m.mine ? ' mine' : ''}`}>
            {m.text}
            <small>{stamp(m.at)}</small>
          </div>
        ))}
      </div>
      {error && <div className="login-error">{error}</div>}
      <form
        className="dm-send"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={draft}
          maxLength={300}
          enterKeyHint="send"
          placeholder="Message"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export function MessagesApp({ game }: { game: Game }) {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [to, setTo] = useState('');

  const load = useCallback(() => {
    void game.conversations().then(
      (r) => setList(r.conversations),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [game]);
  useEffect(load, [load]);

  if (open)
    return (
      <Thread
        game={game}
        name={open}
        onBack={() => {
          setOpen(null);
          load();
        }}
      />
    );
  return (
    <div className="bank">
      <form
        className="dm-send"
        onSubmit={(e) => {
          e.preventDefault();
          if (to.trim()) setOpen(to.trim());
        }}
      >
        <input
          value={to}
          maxLength={29}
          placeholder="Character’s full name"
          onChange={(e) => setTo(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!to.trim()}>
          New
        </button>
      </form>
      {error && <div className="login-error">{error}</div>}
      {list?.length === 0 && (
        <div className="bank-empty">No messages yet. Type a character’s full name to start.</div>
      )}
      {list?.map((c) => (
        <button
          key={c.name}
          type="button"
          className="bank-row dm-row"
          onClick={() => setOpen(c.name)}
        >
          <span className="dm-face">{c.name.slice(0, 1)}</span>
          <span className="bank-what">
            <b>{c.name}</b>
            <small>
              {c.mine ? 'You: ' : ''}
              {c.text}
            </small>
          </span>
          <span className="dm-side">
            <small>{stamp(c.at)}</small>
            {c.unread > 0 && <i>{c.unread}</i>}
          </span>
        </button>
      ))}
    </div>
  );
}
