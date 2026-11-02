/**
 * The cinematic loading screen (technical review §9): scenes of Los Soles fading one into the
 * next with a slow push-in, a caption, rotating tips, and real progress. One component for the
 * boot load and the world-entry load; `children` replaces the progress row (TAP TO PLAY), and
 * an error shows with a retry. The scenes alone (Scenes) are the login's backdrop. Slides are
 * gameplay renders until the art pass replaces them.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { isTouchDevice } from '../game/quality.ts';

interface Slide {
  src: string;
  title: string;
  caption: string;
}

const SLIDES: Slide[] = [
  { src: '/slides/downtown.webp', title: 'Downtown', caption: 'Glass towers and wide avenues.' },
  {
    src: '/slides/stadium.webp',
    title: 'Los Soles Stadium',
    caption: 'Between the towers and the hills.',
  },
  { src: '/slides/hills.webp', title: 'The hills', caption: 'Villas with a view of the bay.' },
  {
    src: '/slides/stadium-night.webp',
    title: 'After dark',
    caption: 'The city stays up all night.',
  },
  {
    src: '/slides/hills-night.webp',
    title: 'Observatory Road',
    caption: 'Hairpins all the way to the top.',
  },
  { src: '/slides/freeway.webp', title: 'The freeway', caption: 'Every district, one ramp away.' },
];

/** Tips for the device in hand (keys on desktop, buttons on touch). */
const TIPS = {
  common: [
    'A day in Los Soles lasts 48 minutes. Nights are darker away from the streetlights.',
    'Players near you can hear you when voice is on.',
    'Your name and age are yours for good once your character is made.',
  ],
  desktop: [
    'Hold Shift to walk instead of run.',
    'Press E next to a car to get in.',
    'Q takes out your pistol. Hold the right mouse button to aim.',
    'Hold V to talk to players near you.',
  ],
  touch: [
    'Put your left thumb down anywhere to move. Drag on the right to look around.',
    'Tap the car button next to a car to get in.',
    'The pistol button takes out your pistol.',
  ],
};
const SLIDE_MS = 6500;
/** The scene showing last, so the world-entry screen carries on from the boot's. */
let lastSlide = 0;
const TIP_MS = 5200;

export function Cinematic({
  progress,
  status,
  error,
  onRetry,
  children,
}: {
  /** 0–1, or null when it can't be known (an indeterminate bar). */
  progress: number | null;
  status: string;
  error?: string | null;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const [tips] = useState(() =>
    shuffle([...TIPS.common, ...TIPS[isTouchDevice() ? 'touch' : 'desktop']]),
  );
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTip((t) => (t + 1) % tips.length), TIP_MS);
    return () => clearInterval(id);
  }, [tips]);

  return (
    <Scenes>
      <div className="cine-foot">
        {error ? (
          <div className="cine-error">
            <span>{error}</span>
            {onRetry && (
              <button type="button" className="btn btn-primary" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        ) : (
          (children ?? (
            <>
              <div key={tip} className="cine-tip">
                <em>Tip</em>
                {tips[tip]}
              </div>
              <div className={`cine-bar${progress === null ? ' busy' : ''}`}>
                <div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
              </div>
              <div className="cine-status">
                <span>{status}</span>
                {progress !== null && <span>{Math.floor(progress * 100)}%</span>}
              </div>
            </>
          ))
        )}
      </div>
    </Scenes>
  );
}

/**
 * The scenes of Los Soles, full screen, with the wordmark and each scene's caption; `children`
 * go on top (the loading row, the login panel). The slideshow carries on across screens.
 */
export function Scenes({
  children,
  captions = true,
}: {
  children?: ReactNode;
  /** Each scene's title and line, bottom left (the main menu puts the player there). */
  captions?: boolean;
}) {
  const [slide, setSlide] = useState(lastSlide);
  // How many scenes have shown (the first appears at once, later ones fade in).
  const [shown, setShown] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setSlide((s) => (lastSlide = (s + 1) % SLIDES.length));
      setShown((n) => n + 1);
    }, SLIDE_MS);
    return () => clearInterval(id);
  }, []);
  // The next scene downloads while this one shows, so the fade never waits on it.
  useEffect(() => {
    const next = SLIDES[(slide + 1) % SLIDES.length];
    if (next) new Image().src = next.src;
  }, [slide]);

  const current = SLIDES[slide] ?? SLIDES[0];
  const previous = SLIDES[(slide + SLIDES.length - 1) % SLIDES.length];
  return (
    <div className="cine">
      {/* The previous scene stays under the new one while it fades in; each keeps its own
          push-in (the inner layer) across the change. The first scene shows without a fade. */}
      {[previous, current].map(
        (s) =>
          s &&
          (s !== previous || previous !== current) && (
            <div key={s.src} className={`cine-slide${s === current && shown > 1 ? ' in' : ''}`}>
              <div style={backdrop(s)} />
            </div>
          ),
      )}
      <div className="cine-shade" />
      <img className="cine-logo" src="/brand/wordmark.webp" alt="fr33world" />
      {captions && current && (
        <div key={`c${current.src}`} className="cine-caption">
          <b>{current.title}</b>
          <span>{current.caption}</span>
        </div>
      )}
      {children}
    </div>
  );
}

const backdrop = (s: Slide) => ({ backgroundImage: `url(${s.src})` });

function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j] as T, list[i] as T];
  }
  return list;
}
