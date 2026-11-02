import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeAppearance, encodeGear } from '@fr33world/shared';
import { playMenuMusic, stopMenuMusic, unlockAudio } from './audio.ts';
import { boot, type BootProgress } from './boot.ts';
import { CharacterCreator } from './auth/CharacterCreator.tsx';
import { LoginScreen, type LoginResult } from './auth/LoginScreen.tsx';
import type { Game, GameSession } from './game/Game.ts';
import { reportError } from './game/report.ts';
import { isTouchDevice } from './game/quality.ts';
import { Chat } from './hud/Chat.tsx';
import { Emotes } from './hud/Emotes.tsx';
import { Hud } from './hud/Hud.tsx';
import { NameTags } from './hud/NameTags.tsx';
import { PerfOverlay } from './hud/PerfOverlay.tsx';
import { loadGame } from './loadGame.ts';
import { Cinematic } from './ui/Cinematic.tsx';
import { retry } from './ui/stale.ts';
import { InstallButton } from './ui/Install.tsx';
import { Settings } from './hud/Settings.tsx';
import { TouchControls } from './hud/TouchControls.tsx';

/**
 * The boot load and TAP TO PLAY, then login (when Privy is configured), then the game. Skipped (play without a login) with
 * `?offline` or `?fly`, in builds without VITE_PRIVY_APP_ID, and on insecure origins: Privy's
 * wallets need HTTPS or localhost, and phones reach the dev server over plain http on the LAN.
 */
export function App({ loginEnabled }: { loginEnabled: boolean }) {
  const params = new URLSearchParams(location.search);
  const skipLogin =
    !loginEnabled ||
    !window.isSecureContext ||
    params.has('offline') ||
    params.has('fly') ||
    // Dev only: play on localhost without logging in (automated tests, microphone checks).
    (import.meta.env.DEV && params.has('nologin'));
  const [session, setSession] = useState<LoginResult | null>(null);
  // Dev only: the character creation screen without a login (?create), then the city.
  const [made, setMade] = useState<GameSession | null>(null);
  const [played, setPlayed] = useState(false);

  if (!played) return <Boot onPlay={() => setPlayed(true)} />;
  if (!skipLogin && !session) return <LoginScreen onReady={setSession} />;
  if (skipLogin && import.meta.env.DEV && params.has('create') && !made) {
    return (
      <CharacterCreator
        busy={false}
        error={null}
        onCreate={(c) =>
          setMade({
            token: '',
            name: c.name,
            look: encodeAppearance(c.appearance),
            gear: encodeGear(c.gear),
          })
        }
      />
    );
  }
  return (
    <GameView
      session={session ?? made ?? { token: '', name: '' }}
      wallet={session?.wallet ?? null}
      account={session ? { name: session.name, guest: session.guest } : null}
      onRetry={retry}
    />
  );
}

/** The boot load on the cinematic screen, then TAP TO PLAY (technical review §9, steps 3–4). */
function Boot({ onPlay }: { onPlay: () => void }) {
  const [progress, setProgress] = useState<BootProgress>({ fraction: 0, status: 'Loading' });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    boot((p) => alive && setProgress(p)).then(
      () => alive && setReady(true),
      (e: unknown) => {
        reportError(e, 'boot load failed');
        if (alive) setError("Los Soles couldn't load. Check your connection and try again.");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const play = useCallback(() => {
    // Inside the tap, as browsers require: sound on, and on Android full screen in landscape
    // (iPhones can't; the orientation gate and the install guide cover them).
    unlockAudio();
    playMenuMusic();
    if (isTouchDevice()) void landscape();
    onPlay();
  }, [onPlay]);
  useEffect(() => {
    if (!ready || isTouchDevice()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') play();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, play]);

  return (
    <Cinematic progress={progress.fraction} status={progress.status} error={error} onRetry={retry}>
      {ready ? (
        <div className="cine-play">
          <button type="button" className="btn btn-primary tap-to-play" onClick={play}>
            {isTouchDevice() ? 'Tap to play' : 'Click to play'}
          </button>
          {!isTouchDevice() && <span>or press Enter</span>}
          <InstallButton />
        </div>
      ) : undefined}
    </Cinematic>
  );
}

/** Full screen, then a landscape lock (Android Chrome; elsewhere it quietly does nothing). */
async function landscape(): Promise<void> {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: 'landscape') => Promise<void>;
    };
    await orientation.lock?.('landscape');
  } catch {
    // Not supported (iPhone) or refused: the orientation gate still asks.
  }
}

function GameView({
  session,
  wallet,
  account,
  onRetry,
}: {
  session: GameSession;
  wallet: string | null;
  /** Logged in (for the settings' Account tab), or null without an account. */
  account: { name: string; guest: boolean } | null;
  onRetry: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    let g: Game | null = null;
    // The game (Three.js, Rapier) is its own download, started while the player logs in.
    loadGame()
      .then(({ Game }) => {
        if (!alive) return;
        g = new Game(canvas, session);
        g.start();
        setGame(g);
        return g.init();
      })
      .then(
        () => {
          if (!alive || !g) return;
          setReady(true);
          // The city's own sounds take over from the menus' music.
          stopMenuMusic();
          // Marker for automated screenshots: the world is loaded.
          document.body.dataset.ready = '1';
        },
        (e: unknown) => {
          reportError(e, 'game failed to load');
          // Nothing to play: stop rendering behind the error (Try again starts a fresh game).
          g?.dispose();
          if (alive) setError("Los Soles couldn't load. Check your connection and try again.");
        },
      );
    // HUD values (clock, prompts, hit markers) refresh ten times a second.
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => {
      alive = false;
      clearInterval(id);
      g?.dispose();
    };
  }, [session]);

  return (
    <>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {game && ready && isTouchDevice() && (
        <TouchControls
          input={game.input}
          action={game.hud.action}
          actionIcon={game.hud.actionIcon}
          driving={game.hud.driving}
          armed={game.hud.armed}
          weapons={game.hud.ownsWeapon}
          voice={game.hud.voice === 'on'}
          talking={game.hud.talking}
        />
      )}
      {game && ready && <NameTags game={game} />}
      {game && ready && <Hud game={game} />}
      {game && ready && <Chat game={game} online={game.hud.net === 'online'} />}
      {game && ready && <Emotes game={game} driving={game.hud.driving} />}
      {game && ready && (
        <Settings
          account={account}
          current={`${game.stats.tier}${game.stats.resolution < 100 ? ` · ${game.stats.resolution}% resolution` : ''}`}
        />
      )}
      {/* The world-entry load (technical review §9, step 8), on the boot's cinematic screen. */}
      {(!ready || error) && (
        <Cinematic
          progress={game ? game.loadProgress().fraction : 0}
          status={game ? game.loadProgress().status : 'Loading'}
          error={error}
          onRetry={onRetry}
        />
      )}
      {/* The full measurement overlay is for testing only now (?perf=1); the HUD shows the
          frame rate and ping. */}
      {game && ready && new URLSearchParams(location.search).get('perf') === '1' && (
        <PerfOverlay game={game} wallet={wallet} />
      )}
    </>
  );
}
