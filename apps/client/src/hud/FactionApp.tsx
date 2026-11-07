/**
 * The phone's Faction app (Phase 9, D-26). Not in one: the four factions and applying, and gangs
 * (GangsView). Applied: the training, one question a page, then a pin to the building and the
 * interview a boss sets on their computer. In one: the rank, the way to the lockers and (for
 * recruiters) the computer, and the roster.
 * Also the Emergency app: calls the police (911) or EMS from where you stand.
 */
import {
  FACTION_BUILDING,
  FACTION_GUIDE,
  FACTION_IDS,
  type FactionId,
  FACTIONS,
  GANG,
  QUIZ,
  quizFor,
} from '@fr33world/shared';
import { useEffect, useState } from 'react';
import type { FactionStatus, GangStatus } from '../game/api.ts';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

/** A location pin to a building: sets the waypoint, then back to the map. */
function Pin({ game, faction, label }: { game: Game; faction: FactionId; label: string }) {
  const [set, setSet] = useState(false);
  return (
    <button
      type="button"
      className="btn pin-btn"
      onClick={() => setSet(game.pinBuilding(FACTION_BUILDING[faction]))}
    >
      <PinIcon />
      {set ? 'On your map' : label}
    </button>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z" />
    </svg>
  );
}

/** The training: one question a page, with how far along you are. */
function Training({
  game,
  faction,
  seed,
  retryAt,
  onDone,
}: {
  game: Game;
  faction: FactionId;
  seed: number;
  retryAt: string | null;
  onDone: (s: FactionStatus, said: string) => void;
}) {
  const f = FACTIONS[faction];
  const quiz = quizFor(faction, seed);
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const q = quiz[page];
  if (retryAt)
    return (
      <div className="bank">
        <div className="bank-title">Training · {f.name}</div>
        <div className="bank-sub">
          Not quite. You can try again at{' '}
          {new Date(retryAt).toLocaleTimeString([], { timeStyle: 'short' })}, with new questions.
        </div>
      </div>
    );
  if (!q) return null;
  const chosen = answers[page];
  const last = page === quiz.length - 1;
  const handIn = () => {
    setSending(true);
    void game.factionQuiz(answers).then(
      (r) =>
        onDone(
          r.status,
          r.passed ? `Passed: ${r.right} of ${r.of}.` : `${r.right} of ${r.of}: not enough.`,
        ),
      (e: unknown) => {
        setSending(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <div className="bank">
      <div className="bank-title">Training · {f.name}</div>
      <div className="quiz-progress" aria-label={`Question ${page + 1} of ${quiz.length}`}>
        {quiz.map((item, i) => (
          <i key={item.q} className={i < page ? 'done' : i === page ? 'now' : ''} />
        ))}
      </div>
      <div className="quiz-count">
        Question {page + 1} of {quiz.length} · {QUIZ.pass} right to pass
      </div>
      <div className="quiz-q">
        <b>{q.q}</b>
        {q.options.map((o, k) => (
          <button
            key={o}
            type="button"
            className={`quiz-option${chosen === k ? ' on' : ''}`}
            onClick={() => setAnswers((a) => Object.assign([...a], { [page]: k }))}
          >
            {o}
          </button>
        ))}
      </div>
      {error && <div className="login-error">{error}</div>}
      <div className="quiz-nav">
        <button
          type="button"
          className="btn"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={chosen === undefined || sending}
          onClick={() => (last ? handIn() : setPage((p) => p + 1))}
        >
          {last ? 'Hand in' : 'Next'}
        </button>
      </div>
    </div>
  );
}

/** Gangs: yours, the others, starting one, and this week's board. */
function GangsView({ game, onBack }: { game: Game; onBack: () => void }) {
  const [s, setS] = useState<GangStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const run = (p: Promise<GangStatus>) =>
    p.then(
      (r) => {
        setS(r);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  useEffect(() => {
    void run(game.gangs());
  }, [game]);
  if (!s)
    return error ? (
      <div className="login-error">{error}</div>
    ) : (
      <div className="bank-sub">Opening…</div>
    );
  const g = s.gang;
  return (
    <div className="bank">
      <button type="button" className="btn" onClick={onBack}>
        ‹ Factions
      </button>
      {error && <div className="login-error">{error}</div>}
      {g && (
        <div className="bank-card faction-card">
          <div className="bank-name">
            {g.name} · {g.tag}
          </div>
          <div className="bank-sub">
            {g.accepted
              ? `${g.leader ? 'You lead it' : 'Member'} · ${g.members.length} in the gang${
                  g.members.length < GANG.minMembers
                    ? ` · ${GANG.minMembers} to make the board`
                    : ''
                }`
              : 'Waiting for the leader to say yes'}
          </div>
        </div>
      )}
      {g?.requests.map((n) => (
        <div key={n} className="bank-row">
          <span className="bank-dot in">?</span>
          <span className="bank-what">
            <b>{n}</b>
            <small>Wants in</small>
          </span>
          <span className="faction-decide">
            <button
              type="button"
              onClick={() => void run(game.gangAction('decide', { name: n, accept: true }))}
            >
              ✓
            </button>
            <button
              type="button"
              onClick={() => void run(game.gangAction('decide', { name: n, accept: false }))}
            >
              ✕
            </button>
          </span>
        </div>
      ))}
      <div className="bank-title">This week’s board</div>
      {s.board.map((r, i) => (
        <div key={r.name} className="bank-row">
          <span className="bank-dot in">{i + 1}</span>
          <span className="bank-what">
            <b>{r.name}</b>
            <small>
              {r.tag} · {r.members} members
            </small>
          </span>
          <span className="bank-amount in">{r.points}</span>
        </div>
      ))}
      <div className="bank-sub">Every job a member does scores for the gang. Resets on Monday.</div>
      {!g && (
        <>
          <div className="bank-title">Join one</div>
          {s.gangs.length === 0 && <div className="bank-sub">None yet: be the first.</div>}
          {s.gangs.map((x) => (
            <button
              key={x.id}
              type="button"
              className="bank-row job-place"
              onClick={() => void run(game.gangAction('join', { gang: x.id }))}
            >
              <span className="bank-dot in">★</span>
              <span className="bank-what">
                <b>{x.name}</b>
                <small>
                  {x.tag} · {x.members} members · ask to join
                </small>
              </span>
              <span className="bank-amount in">›</span>
            </button>
          ))}
          <div className="bank-title">Start one</div>
          <div className="bank-sub">
            {formatMoney(GANG.price)}, level {GANG.minLevel} (you’re {s.level}).
          </div>
          <input
            className="field"
            maxLength={24}
            placeholder="Gang name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="field"
            maxLength={5}
            placeholder="Tag (2 to 5 letters)"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={s.level < GANG.minLevel || name.length < 3 || tag.length < 2}
            onClick={() => void run(game.gangAction('create', { name, tag }))}
          >
            Start the gang
          </button>
        </>
      )}
      {g && (
        <button type="button" className="btn" onClick={() => void run(game.gangAction('leave'))}>
          {g.accepted ? 'Leave the gang' : 'Withdraw request'}
        </button>
      )}
    </div>
  );
}

export function FactionApp({ game }: { game: Game }) {
  const [s, setS] = useState<FactionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const [gangs, setGangs] = useState(false);

  const run = (p: Promise<FactionStatus>) =>
    p.then(
      (r) => {
        setS(r);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  useEffect(() => {
    void run(game.factions());
  }, [game]);

  if (error && !s) return <div className="login-error">{error}</div>;
  if (!s) return <div className="bank-sub">Opening…</div>;
  if (gangs) return <GangsView game={game} onBack={() => setGangs(false)} />;

  const m = s.membership;
  if (m) {
    const f = FACTIONS[m.faction];
    const canRecruit = f.ranks[m.rank - 1]?.powers.includes('recruit');
    const place =
      f.kind === 'police' ? 'Police Station' : f.kind === 'medical' ? 'Hospital' : 'house';
    return (
      <div className="bank">
        <div className="bank-card faction-card" style={{ borderColor: f.colour }}>
          <div className="bank-name">{f.name}</div>
          <div className="bank-balance" style={{ fontSize: 24, color: f.colour }}>
            {m.title}
          </div>
          <div className="bank-sub">
            Rank {m.rank} of {f.ranks.length}
            {f.kind !== 'gang' && f.ranks[m.rank - 1]?.salary
              ? ` · $${(f.ranks[m.rank - 1]?.salary ?? 0) / 100} every 10 min on duty`
              : ''}
          </div>
          {f.kind !== 'gang' && (
            <div className="bank-sub">
              {game.duty ? 'You’re on duty.' : `Go on duty at the lockers in the ${place}.`}
            </div>
          )}
          <Pin game={game} faction={m.faction} label={`Way to the ${place}`} />
        </div>
        {canRecruit && (
          <div className="bank-sub">Applications are on the computer in the {place}.</div>
        )}
        <div className="bank-title">Members</div>
        {s.roster.map((r) => (
          <div key={r.name} className="bank-row">
            <span className="bank-dot in">{r.rank}</span>
            <span className="bank-what">
              <b>{r.name}</b>
              <small>{f.ranks[r.rank - 1]?.title}</small>
            </span>
          </div>
        ))}
        <div className="bank-sub">
          Radio: /f message.{' '}
          {f.kind === 'police' ? 'Officers: /id and /fine “Name” 250 reason. ' : ''}
          {f.kind !== 'gang' ? 'On duty: /vehicle for a service vehicle. ' : ''}
          {canRecruit ? 'Ranks: /promote, /demote, /dismiss “Name”.' : ''}
        </div>
        <button type="button" className="btn" onClick={() => void run(game.leaveFaction())}>
          Leave {f.short}
        </button>
      </div>
    );
  }

  const app = s.application;
  if (app) {
    const f = FACTIONS[app.faction];
    const where =
      app.faction === 'police'
        ? 'the Police Station'
        : app.faction === 'medical'
          ? 'the Hospital'
          : `the ${f.short} house`;
    if (app.stage === 'interview')
      return (
        <div className="bank">
          <div className="bank-card faction-card" style={{ borderColor: f.colour }}>
            <div className="bank-name">{f.name}</div>
            <div className="bank-balance" style={{ fontSize: 22 }}>
              {app.interviewAt ? 'Interview set' : 'Training passed'}
            </div>
            <div className="bank-sub">
              {app.interviewAt
                ? `Be at ${where} on ${new Date(app.interviewAt).toLocaleString([], {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}. A boss will meet you there.`
                : `Your application is with the bosses. When one sets your interview it shows here. You'll meet them at ${where}.`}
            </div>
            <Pin game={game} faction={app.faction} label={`Set location: ${where}`} />
          </div>
          {said && <div className="bank-sub">{said}</div>}
          <button type="button" className="btn" onClick={() => void run(game.leaveFaction())}>
            Withdraw application
          </button>
        </div>
      );
    return (
      <Training
        key={app.quizSeed}
        game={game}
        faction={app.faction}
        seed={app.quizSeed}
        retryAt={app.retryAt}
        onDone={(status, text) => {
          setS(status);
          setSaid(text);
        }}
      />
    );
  }

  return (
    <div className="bank">
      <div className="bank-sub">
        Join a faction: apply, pass its training, then an interview with one of its bosses.
      </div>
      {error && <div className="login-error">{error}</div>}
      <input
        className="field"
        maxLength={200}
        placeholder="Why do you want in? (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {FACTION_IDS.map((id: FactionId) => {
        const f = FACTIONS[id];
        return (
          <button
            key={id}
            type="button"
            className="bank-row job-place"
            onClick={() => void run(game.applyFaction(id, note))}
          >
            <span className="bank-dot in" style={{ color: f.colour }}>
              {f.kind === 'police' ? '🚓' : f.kind === 'medical' ? '🚑' : '★'}
            </span>
            <span className="bank-what">
              <b>{f.name}</b>
              <small>{FACTION_GUIDE[id].tagline} Apply</small>
            </span>
            <span className="bank-amount in">›</span>
          </button>
        );
      })}
      <button type="button" className="btn" onClick={() => setGangs(true)}>
        Gangs and the board
      </button>
    </div>
  );
}

/** The Emergency app: a call to the police or EMS, from here, with a few words. */
export function EmergencyApp({ game, onGo }: { game: Game; onGo: () => void }) {
  const [text, setText] = useState('');
  const call = (cmd: '911' | 'ems') => {
    if (game.command(`/${cmd} ${text.trim() || 'Needs help'}`)) onGo();
  };
  return (
    <div className="bank">
      <div className="bank-sub">They'll come to where you are now. Say what's happening:</div>
      <input
        className="field"
        maxLength={100}
        placeholder="What's happening?"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="button" className="btn btn-primary" onClick={() => call('911')}>
        🚓 Call the police
      </button>
      <button type="button" className="btn" onClick={() => call('ems')}>
        🚑 Call EMS
      </button>
    </div>
  );
}

/** The Inbox app: notices that waited for you (faction news, fines), newest first. */
export function InboxApp({ game }: { game: Game }) {
  const [list, setList] = useState<
    { id: number; text: string; at: string; read: boolean }[] | null
  >(null);
  useEffect(() => {
    void game.inbox(true).then(
      (r) => setList(r.notices),
      () => setList([]),
    );
  }, [game]);
  if (!list) return <div className="bank-sub">Opening…</div>;
  if (list.length === 0) return <div className="bank-sub">Nothing new.</div>;
  return (
    <div className="bank">
      {list.map((n) => (
        <div key={n.id} className="bank-row">
          <span className={`bank-dot${n.read ? '' : ' in'}`}>{n.read ? '·' : '●'}</span>
          <span className="bank-what">
            <b style={{ fontWeight: n.read ? 500 : 700 }}>{n.text}</b>
            <small>
              {new Date(n.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}
