/**
 * The in-game phone (Phase 5): opened with P on a keyboard or the phone button on touch. A
 * home screen of apps, each a page on the phone itself (owner, 2026-10-30: no apps that only
 * open something else): the bank (balance, history, sending money by character name), jobs,
 * the garage, a taxi and progress. Calls, messages and contacts are on the home screen greyed out,
 * coming soon.
 */
import {
  CAR_MODELS,
  PAYMENTS,
  RENTAL,
  rentalLeft,
  rideDistance,
  TAXI,
  taxiFare,
} from '@fr33world/shared';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { titleOf } from '@fr33world/shared';
import {
  type BankItem,
  formatMoney,
  type GarageCar,
  type Progress,
  type Statement,
} from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { isTouchDevice } from '../game/quality.ts';
import { EmergencyApp, FactionApp, InboxApp } from './FactionApp.tsx';
import { MarketApp } from './MarketApp.tsx';
import { listed } from './Minimap.tsx';

type App =
  'bank' | 'progress' | 'jobs' | 'garage' | 'taxi' | 'faction' | 'emergency' | 'inbox' | 'market';
type Screen = 'home' | 'send' | App;
/** On the home screen, greyed out: what a phone has that Los Soles doesn't yet. */
type Soon = 'calls' | 'messages' | 'contacts';
const TITLES: Partial<Record<Screen, string>> = {
  bank: 'Bank',
  send: 'Send money',
  progress: 'Progress',
  jobs: 'Jobs',
  garage: 'Garage',
  taxi: 'Taxi',
  faction: 'Faction',
  emergency: 'Emergency',
  inbox: 'Inbox',
  market: 'Market',
};

/** Dev (?phone=home|bank|send): open on that screen, with a sample bank when not logged in. */
export const PHONE_DEMO = import.meta.env.DEV
  ? (new URLSearchParams(location.search).get('phone') as Screen | null)
  : null;

export function Phone({ game, clock }: { game: Game; clock: string }) {
  const [open, setOpen] = useState(PHONE_DEMO !== null);
  const [screen, setScreen] = useState<Screen>(PHONE_DEMO ?? 'home');
  const unread = game.hud.unread;
  const touch = isTouchDevice();

  const toggle = useCallback(
    (on?: boolean) => {
      setOpen((was) => {
        const next = on ?? !was;
        if (next && document.pointerLockElement) void document.exitPointerLock();
        if (next) game.note('phone');
        // How many notices wait (the Inbox's badge).
        if (next) void game.inbox().catch(() => {});
        if (!next) setScreen('home');
        return next;
      });
    },
    [game],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (e.code === 'KeyP') toggle();
      else if (e.code === 'Escape') toggle(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <>
      {touch && !open && (
        <button
          type="button"
          className="tbtn glass phone-button"
          aria-label="Phone"
          onClick={() => toggle(true)}
        >
          <PhoneIcon />
        </button>
      )}
      {open && (
        <div
          className={`phone${screen === 'home' ? ' at-home' : ''}`}
          role="dialog"
          aria-label="Phone"
        >
          <div className="phone-status">
            <span className="phone-time">{clock}</span>
            <span className="phone-island" />
            <span className="phone-indicators" aria-hidden="true">
              <SignalIcon />
              <WifiIcon />
              <BatteryIcon />
            </span>
          </div>
          {screen !== 'home' && (
            <div className="phone-nav">
              <button
                type="button"
                className="phone-back"
                onClick={() => setScreen(screen === 'send' ? 'bank' : 'home')}
              >
                ‹
              </button>
              <span>{TITLES[screen]}</span>
              <button
                type="button"
                className="phone-x"
                aria-label="Close"
                onClick={() => toggle(false)}
              >
                ✕
              </button>
            </div>
          )}
          <div className="phone-screen">
            {screen === 'home' && <Home clock={clock} onApp={setScreen} unread={unread} />}
            {screen === 'bank' && <Bank game={game} onSend={() => setScreen('send')} />}
            {screen === 'send' && <Send game={game} onDone={() => setScreen('bank')} />}
            {screen === 'progress' && <ProgressApp game={game} />}
            {screen === 'jobs' && <JobsApp game={game} onGo={() => toggle(false)} />}
            {screen === 'garage' && <GarageApp game={game} onGo={() => toggle(false)} />}
            {screen === 'taxi' && <TaxiApp game={game} onGo={() => toggle(false)} />}
            {screen === 'faction' && <FactionApp game={game} />}
            {screen === 'emergency' && <EmergencyApp game={game} onGo={() => toggle(false)} />}
            {screen === 'inbox' && <InboxApp game={game} />}
            {screen === 'market' && <MarketApp game={game} />}
          </div>
          <button
            type="button"
            className="phone-home"
            aria-label="Home"
            onClick={() => (screen === 'home' ? toggle(false) : setScreen('home'))}
          />
        </div>
      )}
    </>
  );
}

/** The home screen: the clock over a city wallpaper, apps in a grid, a dock below. */
function Home({
  clock,
  onApp,
  unread,
}: {
  clock: string;
  onApp: (app: App) => void;
  unread: number;
}) {
  const [soonSaid, setSoonSaid] = useState<string | null>(null);
  useEffect(() => {
    if (!soonSaid) return;
    const t = window.setTimeout(() => setSoonSaid(null), 1600);
    return () => window.clearTimeout(t);
  }, [soonSaid]);
  const icon = (app: App, label: string, Glyph: () => ReactNode, dock = false) => (
    <button key={app} type="button" className="phone-app" onClick={() => onApp(app)}>
      <span className={`app-icon app-${app}`}>
        <Glyph />
      </span>
      {!dock && label}
    </button>
  );
  const soon = (app: Soon, label: string, Glyph: () => ReactNode, dock = false) => (
    <button
      key={app}
      type="button"
      className="phone-app soon"
      aria-label={`${label}: coming soon`}
      onClick={() => setSoonSaid(label)}
    >
      <span className={`app-icon app-${app}`}>
        <Glyph />
      </span>
      {!dock && label}
    </button>
  );
  return (
    <div className="phone-home-screen">
      <div className="phone-lock">
        <b>{clock}</b>
        <span>Los Soles</span>
      </div>
      <div className="phone-apps">
        {icon('jobs', 'Jobs', BriefcaseIcon)}
        {icon('garage', 'Garage', CarIcon)}
        {icon('market', 'Market', TagIcon)}
        {/* Taxis are off for launch (shared TAXI). */}
        {TAXI.enabled && icon('taxi', 'Taxi', TaxiIcon)}
        {icon('progress', 'Progress', StarIcon)}
        {icon('faction', 'Faction', BadgeIcon)}
        {icon('emergency', '911', SirenIcon)}
        {icon('inbox', unread ? `Inbox · ${unread}` : 'Inbox', InboxIcon)}
        {soon('contacts', 'Contacts', ContactsIcon)}
      </div>
      {soonSaid && <div className="phone-soon">{soonSaid} is coming soon</div>}
      <div className="phone-dock">
        {soon('calls', 'Phone', CallIcon, true)}
        {soon('messages', 'Messages', BubbleIcon, true)}
        {icon('bank', 'Bank', BankIcon, true)}
      </div>
    </div>
  );
}

/**
 * The Garage app: your cars, the way to the nearest car park to get one, and to the Car Dealership to
 * buy another.
 */
function GarageApp({ game, onGo }: { game: Game; onGo: () => void }) {
  const [cars, setCars] = useState<GarageCar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    game.garage().then(
      (c) => alive && setCars(c),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [game]);
  return (
    <div className="bank">
      {error && <div className="login-error">{error}</div>}
      {cars && cars.length > 0 && (
        <div className="bank-sub">
          {cars.length === 1 ? 'Your car' : `Your ${cars.length} cars`}: step into the blue P at any
          car park to bring one.
        </div>
      )}
      {cars && cars.length === 0 && (
        <div className="bank-sub">
          No cars: your rental has gone back to the Car Dealership. Buy a car of your own there.
        </div>
      )}
      {cars?.map((c) => {
        const spec = CAR_MODELS[c.model];
        const left = c.expiresAt ? Date.parse(c.expiresAt) - Date.now() : null;
        return (
          <div key={c.id} className="bank-card garage-card">
            {spec && <img className="garage-photo" src={`/ui/cars/${spec.id}.webp`} alt="" />}
            <div>
              <div className="bank-balance" style={{ fontSize: 24 }}>
                {c.name}
              </div>
              {left !== null && (
                <div className="bank-sub rental-note">
                  Free rental for your first {RENTAL.days} days: due back in {rentalLeft(left)}.
                  Earn enough to buy your own at the Car Dealership before then.
                </div>
              )}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          if (game.guideToParking()) onGo();
        }}
      >
        Directions to the nearest car park
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          if (game.guideToDealer()) onGo();
        }}
      >
        Buy a car at the Car Dealership
      </button>
    </div>
  );
}

/** The Taxi app's row icons, by what a place is. */
const PLACE_ICONS: Record<string, string> = {
  mark: '📍',
  park: '🅿️',
  Landmark: '🏛',
  'Courier jobs': '📦',
  'Mining jobs': '⛏',
  'Ore buyer': '⚖️',
  'City guide': 'ℹ️',
};

/**
 * The Taxi app: where to (the spot marked on the map, the nearest car park, the places on the
 * map's list), each with its distance and fare (free while new); pick one, then ride.
 */
function TaxiApp({ game, onGo }: { game: Game; onGo: () => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = game.whereabouts();
  const xp = game.hud.xp ?? 0;
  const free = taxiFare(1000, xp) === 0;
  const places: { key: string; name: string; what: string; x: number; z: number }[] = [];
  const mark = game.waypoints.target;
  if (mark) places.push({ key: 'mark', name: mark.label, what: 'Marked on your map', ...mark });
  if (me) {
    let park: (typeof game.layout.points)[number] | null = null;
    for (const p of game.layout.points)
      if (
        p.kind === 'parking' &&
        (!park || Math.hypot(p.x - me.x, p.z - me.z) < Math.hypot(park.x - me.x, park.z - me.z))
      )
        park = p;
    if (park)
      places.push({
        key: 'park',
        name: park.name ?? 'Car park',
        what: 'Nearest car park: your car',
        x: park.x,
        z: park.z,
      });
  }
  for (const p of listed(game))
    if (p.kind !== 'Parking')
      places.push({ key: `${p.kind}:${p.name}`, name: p.name, what: p.kind, x: p.x, z: p.z });
  const chosen = places.find((p) => p.key === pick) ?? null;
  const far = (p: { x: number; z: number }) => (me ? rideDistance(me.x, me.z, p.x, p.z) : 0);
  const fareOf = (p: { x: number; z: number }) => taxiFare(far(p), xp);
  const ride = () => {
    if (!chosen) return;
    if (game.callTaxi(chosen.x, chosen.z, chosen.name)) onGo();
    else setError("You're offline. Cabs come once you're connected to the city.");
  };
  return (
    <div className="bank">
      <div className="bank-card taxi-card">
        <div className="bank-name">Los Soles Cabs</div>
        <div className="bank-balance" style={{ fontSize: 22 }}>
          {free ? 'Free while you’re new' : 'Anywhere in the city'}
        </div>
        <div className="bank-sub">
          {free
            ? `Rides cost nothing until level ${TAXI.freeBelowLevel}. Pick where to.`
            : `$${TAXI.base / 100} plus $${TAXI.perKm / 100} a km. Pick where to.`}
        </div>
      </div>
      {error && <div className="login-error">{error}</div>}
      {places.map((p) => {
        const km = far(p) / 1000;
        const cents = fareOf(p);
        return (
          <button
            key={p.key}
            type="button"
            className={`bank-row job-place taxi-place${p.key === pick ? ' on' : ''}`}
            onClick={() => setPick(p.key)}
          >
            <span className="bank-dot in">
              {PLACE_ICONS[p.key === 'mark' ? 'mark' : p.key === 'park' ? 'park' : p.what] ?? '📍'}
            </span>
            <span className="bank-what">
              <b>{p.name}</b>
              <small>
                {p.what} · {km < 0.1 ? 'here' : `${km.toFixed(1)} km`}
              </small>
            </span>
            <span className="bank-amount in">{cents === 0 ? 'Free' : formatMoney(cents)}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="btn btn-primary taxi-go"
        disabled={!chosen || game.hud.driving}
        onClick={ride}
      >
        {game.hud.driving
          ? 'Get out of the car first'
          : chosen
            ? `Ride to ${chosen.name}`
            : 'Pick where to'}
      </button>
    </div>
  );
}

/** The Jobs app: the shift on now, and where to find work (a waypoint there). */
function JobsApp({ game, onGo }: { game: Game; onGo: () => void }) {
  const job = game.job;
  const places = game.layout.points.filter(
    (p) => p.kind === 'depot' || p.kind === 'quarry_office' || p.kind === 'taxi_depot',
  );
  return (
    <div className="bank">
      {job ? (
        <div className="bank-card">
          <div className="bank-name">On shift</div>
          <div className="bank-balance" style={{ fontSize: 26 }}>
            {job.title}
          </div>
          <div className="bank-sub">{job.step}</div>
          <button type="button" className="btn" onClick={() => game.quitJob()}>
            Quit shift
          </button>
        </div>
      ) : (
        <div className="bank-sub">No shift on. Pick a job and head there:</div>
      )}
      <div className="bank-title">Work in the city</div>
      {places.map((p) => (
        <button
          key={p.name}
          type="button"
          className="bank-row job-place"
          onClick={() => {
            game.waypoints.set({ x: p.x, z: p.z, label: p.name ?? 'Work', by: 'map' });
            onGo();
          }}
        >
          <span className="bank-dot in">
            {p.kind === 'depot' ? '📦' : p.kind === 'taxi_depot' ? '🚕' : '⛏'}
          </span>
          <span className="bank-what">
            <b>
              {p.kind === 'depot'
                ? 'Courier'
                : p.kind === 'taxi_depot'
                  ? 'Taxi driver (level 2)'
                  : 'Mining · Los Soles Quarry'}
            </b>
            <small>{p.name} · tap for directions</small>
          </span>
          <span className="bank-amount in">›</span>
        </button>
      ))}
    </div>
  );
}

/** What a history line says (the ledger's kinds in words). */
function describe(item: BankItem): string {
  if (item.kind === 'payment')
    return item.amount < 0 ? `To ${item.other ?? 'someone'}` : `From ${item.other ?? 'someone'}`;
  const known: Record<string, string> = {
    signup_bonus: 'Starter grant',
    'earn:jobs': 'Job pay',
    'earn:salary': 'Salary',
    'earn:tutorial': 'Tutorial reward',
    'spend:car': 'New car · Car Dealership',
    correction: 'Adjustment',
  };
  if (known[item.kind]) return known[item.kind] as string;
  const [, what = item.kind] = item.kind.split(':');
  return what.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function when(at: string): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function Bank({ game, onSend }: { game: Game; onSend: () => void }) {
  const [s, setS] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    game.statement().then(
      (r) => alive && setS(r),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [game]);

  const more = () => {
    const last = s?.history.at(-1);
    if (!s || !last) return;
    setBusy(true);
    game.statement(last.id).then(
      (r) => {
        setS({ ...r, history: [...s.history, ...r.history] });
        setBusy(false);
      },
      () => setBusy(false),
    );
  };

  return (
    <div className="bank">
      <div className="bank-card">
        <div className="bank-name">Bank</div>
        <div className="bank-balance">{s ? formatMoney(s.balance) : '…'}</div>
        <div className="bank-sub">{s?.frozen ? 'Frozen while it’s reviewed' : 'Available'}</div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSend}
          disabled={!s || s.frozen}
        >
          Send money
        </button>
      </div>
      {error && <div className="login-error">{error}</div>}
      <div className="bank-title">History</div>
      <div className="bank-history">
        {s && s.history.length === 0 && <div className="bank-empty">Nothing yet.</div>}
        {s?.history.map((h) => (
          <div key={h.id} className="bank-row">
            <span className={`bank-dot ${h.amount > 0 ? 'in' : 'out'}`}>
              {h.amount > 0 ? '↓' : '↑'}
            </span>
            <span className="bank-what">
              <b>{describe(h)}</b>
              <small>
                {when(h.at)}
                {h.note ? ` · ${h.note}` : ''}
              </small>
            </span>
            <span className={`bank-amount ${h.amount > 0 ? 'in' : 'out'}`}>
              {h.amount > 0 ? '+' : '−'}
              {formatMoney(Math.abs(h.amount))}
            </span>
          </div>
        ))}
        {s?.more && (
          <button type="button" className="btn btn-link" onClick={more} disabled={busy}>
            {busy ? 'Loading…' : 'Older'}
          </button>
        )}
      </div>
    </div>
  );
}

/** A fresh id for one send, so a retry of the same send pays once. */
const sendId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

function Send({ game, onDone }: { game: Game; onDone: () => void }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(sendId);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const nearby = game.nearbyNames();
  const cents = Math.round(Number(amount) * 100);
  const valid =
    to.trim().length > 0 &&
    Number.isFinite(cents) &&
    cents >= PAYMENTS.min &&
    cents <= PAYMENTS.max;

  if (sent)
    return (
      <div className="bank-sent">
        <div className="bank-check">✓</div>
        <b>{formatMoney(cents)} sent</b>
        <span>to {sent}</span>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    );

  return (
    <form
      className="bank-send"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        if (!confirm) return setConfirm(true);
        setBusy(true);
        setError(null);
        game.pay({ to: to.trim(), cents, note: note.trim(), key }).then(
          (name) => setSent(name),
          (err: unknown) => {
            setBusy(false);
            setConfirm(false);
            setError(err instanceof Error ? err.message : String(err));
          },
        );
      }}
    >
      <div className="bank-title">Send money</div>
      <label>
        To
        <input
          value={to}
          placeholder="First Last"
          maxLength={29}
          autoComplete="off"
          onChange={(e) => {
            setTo(e.target.value);
            setConfirm(false);
          }}
        />
      </label>
      {nearby.length > 0 && !to && (
        <div className="chips">
          {nearby.map((n) => (
            <button key={n} type="button" onClick={() => setTo(n)}>
              {n}
            </button>
          ))}
        </div>
      )}
      <label>
        Amount
        <span className="bank-amount-field">
          $
          <input
            value={amount}
            inputMode="decimal"
            placeholder="0"
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^\d.]/g, ''));
              setConfirm(false);
            }}
          />
        </span>
      </label>
      <label>
        Note
        <input
          value={note}
          maxLength={PAYMENTS.noteChars}
          placeholder="What for? (optional)"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && <div className="login-error">{error}</div>}
      <div className="login-fine">
        {formatMoney(PAYMENTS.min)}–{formatMoney(PAYMENTS.max)} a payment. Payments can’t be undone.
      </div>
      <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
        {busy ? 'Sending…' : confirm ? `Confirm ${formatMoney(cents)} to ${to.trim()}` : 'Review'}
      </button>
    </form>
  );
}

function ProgressApp({ game }: { game: Game }) {
  const [p, setP] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    game.progress().then(
      (r) => alive && setP(r),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [game]);
  return (
    <div className="bank">
      <div className="bank-card progress-card">
        <div className="bank-name">{p ? titleOf(p.level) : 'Level'}</div>
        <div className="bank-balance">Level {p?.level ?? '…'}</div>
        {p && (
          <>
            <div className="xp-track">
              <i style={{ width: `${p.next ? (p.into / p.next) * 100 : 100}%` }} />
            </div>
            <div className="bank-sub">
              {p.next ? `${p.into} / ${p.next} XP to level ${p.level + 1}` : 'Top level'}
            </div>
          </>
        )}
      </div>
      {error && <div className="login-error">{error}</div>}
      <div className="bank-title">Rewards</div>
      <div className="bank-history">
        {p && p.history.length === 0 && (
          <div className="bank-empty">Work a job or finish the tutorial to earn XP.</div>
        )}
        {p?.history.map((h) => (
          <div key={h.id} className="bank-row">
            <span className="bank-dot in">★</span>
            <span className="bank-what">
              <b>{h.reason}</b>
              <small>{when(h.at)}</small>
            </span>
            <span className="bank-amount in">
              {h.xp > 0 ? `+${h.xp} XP` : ''}
              {h.cents > 0 && <small className="reward-cash">{formatMoney(h.cents)}</small>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
      <path d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9-4.4-4.1 6-.7z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <rect
        x="6.5"
        y="2.5"
        width="11"
        height="19"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path d="M10.5 18.5h3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function BankIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
      <path d="M3 9.5 12 4l9 5.5" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path
        d="M5.5 10.5v7M10 10.5v7M14 10.5v7M18.5 10.5v7M3.5 20h17"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SignalIcon() {
  return (
    <svg viewBox="0 0 18 12" width="17" height="11" fill="currentColor">
      <rect x="0" y="8" width="3" height="4" rx="1" />
      <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
      <rect x="10" y="3" width="3" height="9" rx="1" />
      <rect x="15" y="0" width="3" height="12" rx="1" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg
      viewBox="0 0 16 12"
      width="15"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M1.5 4.5a9.5 9.5 0 0 1 13 0M4 7.2a6 6 0 0 1 8 0" />
      <circle cx="8" cy="10" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg viewBox="0 0 26 12" width="24" height="11" fill="none">
      <rect
        x="0.6"
        y="0.6"
        width="21.8"
        height="10.8"
        rx="3"
        stroke="currentColor"
        strokeOpacity="0.5"
      />
      <rect x="2.2" y="2.2" width="15.5" height="7.6" rx="1.6" fill="currentColor" />
      <path
        d="M24 4v4"
        stroke="currentColor"
        strokeOpacity="0.5"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const glyph = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function BriefcaseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2.5" />
      <path d="M9 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5v2M3.5 12.5h17" />
    </svg>
  );
}

function CallIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
      <path d="M6.6 3.5c.6-.2 1.2.1 1.5.6l1.6 3.1c.3.5.1 1.2-.3 1.6l-1.3 1.1c.9 2 2.5 3.6 4.5 4.6l1.1-1.4c.4-.5 1-.6 1.6-.3l3.1 1.6c.5.3.8.9.6 1.5l-.6 2.2c-.2.7-.8 1.1-1.5 1.1C9.9 19.2 4.8 14.1 4.4 7.6c0-.7.4-1.3 1.1-1.5z" />
    </svg>
  );
}

function ContactsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5.5 19.5c1-3.2 3.6-5 6.5-5s5.5 1.8 6.5 5" />
    </svg>
  );
}

function BubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
      <path d="M12 4c-4.97 0-9 3.36-9 7.5 0 2.1 1.04 4 2.73 5.36-.15 1.3-.75 2.48-1.73 3.4 2 .1 3.9-.5 5.36-1.62.85.24 1.73.36 2.64.36 4.97 0 9-3.36 9-7.5S16.97 4 12 4z" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <path d="M3 12V4h8l10 10-8 8z" />
      <circle cx="7.5" cy="8.5" r="1.4" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <path d="M4 5h16v14H4z" />
      <path d="M4 13h5l1.5 2h3L15 13h5" />
    </svg>
  );
}

function BadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function SirenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <path d="M7 18v-6a5 5 0 0 1 10 0v6" />
      <path d="M5 18h14v3H5zM12 3v2M4.5 6l1.5 1.5M19.5 6 18 7.5" />
    </svg>
  );
}

function TaxiIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <path d="M9.5 7.5 10 5.5h4l.5 2" />
      <path d="M4 15.5v-3l2-5h12l2 5v3" />
      <path d="M3 15.5h18v2.5H3z" />
      <circle cx="7.5" cy="18.5" r="1.4" />
      <circle cx="16.5" cy="18.5" r="1.4" />
    </svg>
  );
}

function CarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...glyph}>
      <path d="M4 15.5v-3l2-5h12l2 5v3" />
      <path d="M3 15.5h18v2.5H3z" />
      <circle cx="7.5" cy="18.5" r="1.4" />
      <circle cx="16.5" cy="18.5" r="1.4" />
      <path d="M6.5 12h11" />
    </svg>
  );
}
