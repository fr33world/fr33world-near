/**
 * Login (PRD §4 step 5) through Privy: email, Google, Discord or X in Privy's modal, or as a
 * guest after a plain account of what that means (technical review C9: on this device only,
 * 30 days, can't be merged into an existing account later). A guest who makes a character is
 * offered to keep it by linking an account (Privy upgrades the same user), and is warned
 * before logging out. A NEAR wallet is created behind the scenes for real accounts (D-41); the
 * player never sees wallet jargon here. Hands the game an access token the world server verifies.
 */
import { useGuestAccounts, useLoginWithOAuth, usePrivy, type User } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { decodeAppearance, decodeGear, handleFor } from '@fr33world/shared';
import { useEffect, useRef, useState } from 'react';
import type { GameSession } from '../game/Game.ts';
import { TERMS_VERSION } from '@fr33world/shared';
import {
  ApiError,
  type ApiSession,
  createCharacter,
  openApiSession,
  submitOnboarding,
  wakeApi,
} from '../game/api.ts';
import { Scenes } from '../ui/Cinematic.tsx';
import { type Platform, PlatformButtons } from '../ui/platforms.tsx';
import { InstallButton } from '../ui/Install.tsx';
import type { CharacterPreview } from '../game/character/preview.ts';
import { CharacterCreator, type NewCharacter } from './CharacterCreator.tsx';
import { fetchStatus, type ServerStatus, wakeServer } from '../game/server.ts';

type Need = 'age' | 'terms' | 'character';
/** World tickets last five minutes (packages/auth): older than this, PLAY gets a fresh one. */
const TICKET_FRESH_MS = 4 * 60_000;
type Joined = {
  token: string;
  name: string;
  balance: number | null;
  look?: number;
  gear?: number;
  xp?: number;
  tutorial?: string;
};

export interface LoginResult extends GameSession {
  guest: boolean;
  /** The account's embedded NEAR wallet address, once created. */
  wallet: string | null;
  /** Signs a transaction hash on this device, for the player's own USDC (usdc.ts). */
  signHash?: (hash: `0x${string}`) => Promise<string>;
}

/**
 * The account's name: the one the person gave their login (their Google name, their Discord
 * or X handle), never their email address (owner, 2026-11-12); otherwise a game handle such
 * as "Golden Coyote 27", the same on every login. In the city everyone goes by their
 * character's name, which they type themselves.
 */
function displayName(user: User | null): string {
  if (!user) return '';
  const given = [user.google?.name, user.discord?.username, user.twitter?.username]
    .map((n) => n?.trim())
    .find(Boolean);
  return (given ?? handleFor(user.id)).slice(0, 24);
}

export function LoginScreen({ onReady }: { onReady: (r: LoginResult) => void }) {
  const {
    ready,
    authenticated,
    user,
    login,
    logout,
    getAccessToken,
    linkEmail,
    linkGoogle,
    linkDiscord,
    linkTwitter,
  } = usePrivy();
  const { createGuestAccount } = useGuestAccounts();
  const { initOAuth } = useLoginWithOAuth();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const walletAsked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<Need[] | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  // Guests: the briefing before the guest account is made, the logout warning, and a new
  // character waiting to enter while its player decides whether to keep it.
  const [briefing, setBriefing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [keep, setKeep] = useState<Joined | null>(null);
  // Returning players: the main menu, with the ticket and when it was issued.
  const [menu, setMenu] = useState<(Joined & { at: number }) | null>(null);
  const guest = user?.isGuest ?? false;
  const nearAccount = user?.linkedAccounts.find(
    (a) => a.type === 'wallet' && 'chainType' in a && a.chainType === 'near',
  ) as { address: string } | undefined;
  const wallet = nearAccount?.address ?? null;

  const privyToken = async () => {
    // Privy has been seen to never settle (a failed wallet setup); don't spin forever.
    const token = await Promise.race([
      getAccessToken(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Logging in took too long. Please try again.')), 20_000),
      ),
    ]);
    if (!token) throw new Error('Could not get a login token');
    return token;
  };

  // Real accounts get their NEAR wallet (USDC) in the background; guests don't.
  useEffect(() => {
    if (!ready || !authenticated || guest || walletAsked.current || wallet) return;
    walletAsked.current = true;
    createWallet({ chainType: 'near' }).catch((e: unknown) =>
      console.warn('could not create the NEAR wallet', e),
    );
  }, [ready, authenticated, guest, wallet]);

  /**
   * Privy login → game session: a world ticket, or the onboarding still needed. The API may be
   * asleep (free hosting): wait for it to wake, saying so, rather than fail.
   */
  const session = async (): Promise<Joined | { needs: Need[] }> => {
    const token = await privyToken();
    await wakeApi(() => setWaking(true));
    setWaking(false);
    const s = await openApiSession(token, displayName(user));
    return joined(s) ?? { needs: s.needs };
  };

  /** In the city: the character's name and look, with the world ticket. */
  const joined = (s: ApiSession): Joined | null =>
    s.ticket
      ? {
          token: s.ticket,
          name: s.character?.name ?? s.account.name,
          balance: s.balance,
          ...(s.character
            ? {
                look: s.character.look,
                gear: s.character.gear,
                xp: s.character.xp,
                tutorial: s.character.tutorial,
              }
            : {}),
        }
      : null;

  const enter = (j: Joined) =>
    onReady({
      ...j,
      guest,
      wallet,
      signHash: wallet
        ? async (hash) =>
            (await signRawHash({ address: wallet, chainType: 'near', hash })).signature
        : undefined,
      renew: async () => {
        const s = await session();
        if ('needs' in s) throw new Error('Please log in again');
        return s.token;
      },
      // For the game's own calls to the API (blocks, reports).
      apiToken: privyToken,
    });

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.blocked) setBlocked(e.message);
    else setError(e instanceof Error ? e.message : String(e));
    setBusy(false);
  };

  const play = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await session();
      if ('needs' in s) setNeeds(s.needs);
      else setMenu({ ...s, at: Date.now() });
      setBusy(false);
    } catch (e) {
      fail(e);
    }
  };

  const onboard = async (birthDate: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const s = await submitOnboarding(await privyToken(), {
        ...(birthDate ? { birthDate } : {}),
        ...(needs?.includes('terms') ? { termsVersion: TERMS_VERSION } : {}),
      });
      const j = joined(s);
      if (j) setMenu({ ...j, at: Date.now() });
      else setNeeds(s.needs);
      setBusy(false);
    } catch (e) {
      fail(e);
    }
  };

  const create = async (c: NewCharacter) => {
    setBusy(true);
    setError(null);
    try {
      const j = joined(await createCharacter(await privyToken(), c));
      // A guest's new character is worth keeping: offer to link an account first.
      if (j && guest) {
        setKeep(j);
        setBusy(false);
      } else if (j) enter(j);
      else setBusy(false);
    } catch (e) {
      fail(e);
    }
  };

  // Returning players skip straight past the buttons.
  useEffect(() => {
    if (ready && authenticated && !busy && !keep) void play();
  }, [ready, authenticated]);
  // A guest who linked an account (Privy's email modal) is a full account now: in they go,
  // with a fresh ticket that says so. (Google, Discord and X go by redirect and come back
  // through the line above.)
  useEffect(() => {
    if (keep && user && !user.isGuest) {
      setKeep(null);
      void play();
    }
  }, [keep, user?.isGuest]);

  // The last step, its own full screen: making the character.
  if (
    ready &&
    authenticated &&
    !blocked &&
    !keep &&
    needs?.length === 1 &&
    needs[0] === 'character'
  ) {
    return <CharacterCreator busy={busy} error={error} onCreate={(c) => void create(c)} />;
  }

  const links = { email: linkEmail, google: linkGoogle, discord: linkDiscord, x: linkTwitter };

  /** Straight into a platform's sign-in: Google, Discord and X by redirect; email in Privy's form. */
  const signIn = (p: Platform) => {
    setError(null);
    if (p === 'email') return login({ loginMethods: ['email'] });
    initOAuth({ provider: p === 'x' ? 'twitter' : p }).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  /** PLAY from the main menu: into the city, with a fresh ticket if this one is getting old. */
  const playFromMenu = async (m: Joined & { at: number }) => {
    setBusy(true);
    setError(null);
    try {
      const s = Date.now() - m.at > TICKET_FRESH_MS ? await session() : m;
      if ('needs' in s) {
        setMenu(null);
        setNeeds(s.needs);
        setBusy(false);
      } else enter(s);
    } catch (e) {
      fail(e);
    }
  };

  if (menu && !blocked && !leaving) {
    return (
      <MainMenu
        player={menu}
        guest={guest}
        busy={busy}
        error={error}
        links={links}
        onPlay={() => void playFromMenu(menu)}
        onLogout={() => (guest ? setLeaving(true) : void logout().then(() => setMenu(null)))}
      />
    );
  }

  return (
    <Scenes>
      <div className="login-side">
        <div className="login-panel glass">
          {!ready ? (
            <div className="login-note">Loading…</div>
          ) : blocked ? (
            <>
              <div className="login-note">{blocked}</div>
              <button className="btn btn-link" onClick={() => void logout()}>
                Log out
              </button>
            </>
          ) : keep ? (
            <>
              <div className="login-heading">Keep {keep.name}?</div>
              <div className="login-note">
                You're playing as a guest, so {keep.name} lives on this device only, for 30 days.
                Link an account to keep your character, money and progress for good.
              </div>
              <LinkButtons links={links} />
              <button className="btn btn-link" onClick={() => enter(keep)}>
                Not now, enter Los Soles
              </button>
            </>
          ) : leaving ? (
            <>
              <div className="login-heading">Log out of the guest?</div>
              <div className="login-note">
                A guest can't log back in. Its character, money and progress are gone for good once
                you log out.
              </div>
              <button className="btn btn-primary" onClick={() => setLeaving(false)}>
                Stay
              </button>
              <button
                className="btn"
                onClick={() => {
                  setLeaving(false);
                  setMenu(null);
                  void logout();
                }}
              >
                Log out anyway
              </button>
            </>
          ) : authenticated && needs && needs.length > 0 ? (
            <Onboarding needs={needs} busy={busy} onSubmit={(d) => void onboard(d)} />
          ) : authenticated ? (
            <>
              <div className="login-note">
                Signed in as <b>{displayName(user)}</b>
              </div>
              <button className="btn btn-primary" disabled={busy} onClick={() => void play()}>
                {waking ? 'Waking the server…' : busy ? 'Joining…' : 'Play'}
              </button>
              {guest && (
                <>
                  <GuestFacts />
                  <LinkButtons links={links} />
                </>
              )}
              <button
                className="btn btn-link"
                onClick={() => (guest ? setLeaving(true) : void logout())}
              >
                Log out
              </button>
            </>
          ) : briefing ? (
            <>
              <div className="login-heading">Playing as a guest</div>
              <GuestFacts />
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  // Straight on into the game: the "already logged in" effect above skips
                  // while busy, so without this a new guest sat on "Joining…" forever.
                  createGuestAccount().then(
                    () => void play(),
                    (e: unknown) => {
                      setError(e instanceof Error ? e.message : String(e));
                      setBusy(false);
                    },
                  );
                }}
              >
                {busy ? 'Joining…' : 'Continue as guest'}
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBriefing(false);
                  login();
                }}
              >
                Log in instead
              </button>
            </>
          ) : (
            <>
              <div className="login-heading">Welcome to Los Soles</div>
              <div className="login-note">
                Log in to keep your character, money and cars on any device.
              </div>
              <PlatformButtons disabled={busy} onPick={signIn} />
              <div className="login-or">or</div>
              <button className="btn" onClick={() => setBriefing(true)}>
                Play as guest
              </button>
            </>
          )}
          {error && <div className="login-error">{error}</div>}
        </div>
        <div className="login-foot">
          <InstallButton />
          <ServerLine />
          <span className="login-age">18+</span>
        </div>
      </div>
    </Scenes>
  );
}

/** What being a guest means, said before it matters (technical review C9). */
function GuestFacts() {
  return (
    <ul className="guest-facts">
      <li>
        <b>This device only.</b> Another phone or browser starts from scratch.
      </li>
      <li>
        <b>Kept for 30 days.</b> Clearing your browser's data deletes it sooner.
      </li>
      <li>
        <b>Keep it for good</b> by linking an email, Google, Discord or X account, any time.
      </li>
      <li>
        <b>Already have an account?</b> Log in to it instead: a guest's progress can't be moved into
        an account that already exists.
      </li>
    </ul>
  );
}

/** Link a login to the guest: Privy upgrades the same user, keeping everything. */
export function LinkButtons({
  links,
}: {
  links: Record<'email' | 'google' | 'discord' | 'x', () => void>;
}) {
  return (
    <div className="link-buttons">
      <span>Keep it with</span>
      <PlatformButtons onPick={(p) => links[p]()} />
    </div>
  );
}

/**
 * First login only: date of birth (18+, asked once, can't be changed) and the Terms and
 * Privacy Policy. The server decides; this only collects the answers.
 */
function Onboarding({
  needs,
  busy,
  onSubmit,
}: {
  needs: Need[];
  busy: boolean;
  onSubmit: (birthDate: string | null) => void;
}) {
  const [birthDate, setBirthDate] = useState('');
  const [agreed, setAgreed] = useState(false);
  const needAge = needs.includes('age');
  const needTerms = needs.includes('terms');
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form
      className="onboarding"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(needAge ? birthDate : null);
      }}
    >
      <div className="login-heading">One last step</div>
      {needAge && (
        <label className="field">
          <span>Date of birth</span>
          <input
            type="date"
            required
            min="1900-01-01"
            max={today}
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
          />
        </label>
      )}
      {needAge && (
        <div className="login-fine">
          fr33world is for players aged 18 and over. You can't change this later.
        </div>
      )}
      {needTerms && (
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            I agree to the{' '}
            <a href="/legal/terms.html" target="_blank" rel="noreferrer">
              Terms
            </a>{' '}
            and the{' '}
            <a href="/legal/privacy.html" target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
          </span>
        </label>
      )}
      <button
        className="btn btn-primary"
        type="submit"
        disabled={busy || (needAge && !birthDate) || (needTerms && !agreed)}
      >
        {busy ? 'Checking…' : 'Enter Los Soles'}
      </button>
    </form>
  );
}

/**
 * The main menu (technical review §9, step 7b), for returning players: their character in the
 * city, their name and money, the server (Horizon) with its state, and PLAY. Only buttons that
 * work. The realtime connection opens on PLAY, not here (C10); a full server holds PLAY until
 * a place frees up (C17), an offline one still lets them explore. The preview loads the
 * character's own models, which the city then finds already loaded.
 */
function MainMenu({
  player,
  guest,
  busy,
  error,
  links,
  onPlay,
  onLogout,
}: {
  player: Joined;
  guest: boolean;
  busy: boolean;
  error: string | null;
  links: Record<'email' | 'google' | 'discord' | 'x', () => void>;
  onPlay: () => void;
  onLogout: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status, state, retry } = useServerStatus();

  useEffect(() => {
    if (player.look === undefined) return;
    const look = decodeAppearance(player.look);
    let alive = true;
    let preview: CharacterPreview | null = null;
    void import('../game/character/preview.ts').then(({ CharacterPreview }) => {
      const canvas = canvasRef.current;
      if (!alive || !canvas) return;
      preview = new CharacterPreview(canvas);
      void preview.show(look, decodeGear(player.gear ?? 0));
    });
    return () => {
      alive = false;
      preview?.dispose();
    };
  }, [player.look, player.gear]);

  return (
    <Scenes captions={false}>
      <div className="menu-stage">
        <canvas ref={canvasRef} />
      </div>
      <div className="menu-player">
        <b>{player.name}</b>
        <span>
          {player.balance !== null && <em>${(player.balance / 100).toLocaleString('en-US')}</em>}
          {guest && <span className="menu-tag">Guest</span>}
        </span>
      </div>
      <div className="login-side">
        <div className="login-panel glass">
          <div className="menu-label">Server</div>
          {/* The server as a card over the city it runs (owner: a picture, not a dot). */}
          <div className={`server-card ${state}`}>
            <span className={`server-state ${state}`}>
              <span className={`dot ${serverDot(state)}`} />
              {state === 'up'
                ? 'Online'
                : state === 'full'
                  ? 'Full'
                  : state === 'down'
                    ? 'Offline'
                    : state === 'waking'
                      ? 'Waking'
                      : 'Checking'}
            </span>
            <b>{status?.name ?? 'Horizon'}</b>
            <span className="server-line">{serverText(state, status)}</span>
            {status && (
              <span className="server-load">
                <span
                  style={{ width: `${Math.min(100, (status.players / status.capacity) * 100)}%` }}
                />
              </span>
            )}
            {state === 'down' && (
              <button className="btn btn-link server-retry" onClick={retry}>
                Retry
              </button>
            )}
          </div>
          <button
            className="btn btn-primary menu-play"
            disabled={busy || state === 'full'}
            onClick={onPlay}
          >
            {busy
              ? 'Joining…'
              : state === 'full'
                ? 'Waiting for a place'
                : state === 'down'
                  ? 'Explore offline'
                  : 'Play'}
          </button>
          {state === 'full' && (
            <div className="login-fine">Play unlocks as soon as someone leaves.</div>
          )}
          {guest && (
            <>
              <div className="login-fine">
                Playing as a guest: {player.name} lives on this device only, for 30 days.
              </div>
              <LinkButtons links={links} />
            </>
          )}
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn-link" onClick={onLogout}>
            Log out
          </button>
        </div>
        <div className="login-foot">
          <InstallButton />
        </div>
      </div>
    </Scenes>
  );
}

type ServerState = 'checking' | 'waking' | 'up' | 'full' | 'down';

/**
 * Horizon's state from the world server's /status (technical review §9, step 6: over HTTP, no
 * realtime slot held while in menus). Asking also wakes a sleeping free-plan server, so it's
 * starting up while the player logs in. Asked again every 30 seconds, every 8 while full (to
 * catch a free place); `retry` asks again after a failure.
 */
function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [state, setState] = useState<ServerState>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const set = (s: ServerStatus) => {
      if (!alive) return;
      setStatus(s);
      setState(s.players >= s.capacity ? 'full' : 'up');
    };
    setState('checking');
    wakeServer(undefined, () => alive && setState('waking')).then(set, () => {
      if (alive) setState('down');
    });
    return () => {
      alive = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (state !== 'up' && state !== 'full') return;
    const id = setInterval(
      () => {
        fetchStatus().then(
          (s) => {
            setStatus(s);
            setState(s.players >= s.capacity ? 'full' : 'up');
          },
          () => setState('down'),
        );
      },
      state === 'full' ? 8000 : 30_000,
    );
    return () => clearInterval(id);
  }, [state]);

  return { status, state, retry: () => setAttempt((n) => n + 1) };
}

/** Who's online, under the login panel. */
function ServerLine() {
  const { status, state } = useServerStatus();
  return (
    <div className="chip glass">
      <span className={`dot ${serverDot(state)}`} />
      {serverText(state, status)}
    </div>
  );
}

const serverDot = (state: ServerState) =>
  state === 'up' ? 'on' : state === 'checking' ? '' : state === 'full' ? 'waking' : state;

function serverText(state: ServerState, status: ServerStatus | null): string {
  if (state === 'up' && status) return `${status.players} online · ${status.gameTime} in Los Soles`;
  if (state === 'full' && status) return `Full · ${status.players} of ${status.capacity} players`;
  if (state === 'waking') return 'Waking the server, about a minute…';
  if (state === 'down') return 'Server offline. You can still explore.';
  return 'Checking the server…';
}
