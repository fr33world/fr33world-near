/**
 * "Install the app" (technical review §9): on Android and desktop Chrome the browser's own
 * install prompt; on iPhone and iPad, which have none, a sheet showing Add to Home Screen.
 * The installed app is the only way to play full screen in landscape on an iPhone. Hidden
 * once installed, or where installing isn't possible.
 */
import { useEffect, useState } from 'react';
import { Modal } from './Modal.tsx';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// The browser offers the prompt once, early (often before React is up): keep it.
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
  for (const l of listeners) l();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  for (const l of listeners) l();
});

/** Running as the installed app (home screen), not in a browser tab. */
export const installed = (): boolean =>
  matchMedia('(display-mode: fullscreen)').matches ||
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone or iPad (iPads report themselves as Macs, but with touch). */
const ios = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

/** Registers the service worker (production builds only: dev serves files as they change). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e: unknown) => {
      console.warn('service worker not registered', e);
    });
  });
}

/** A small "Install the app" button, where installing is possible and not yet done. */
export function InstallButton({ className = 'chip glass install-chip' }: { className?: string }) {
  const [, setTick] = useState(0);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (installed() || (!deferred && !ios())) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          // iOS has no install prompt of its own: always the sheet there.
          if (deferred && !ios()) {
            void deferred.prompt();
            void deferred.userChoice.then(() => {
              deferred = null;
              setTick((n) => n + 1);
            });
          } else setSheet(true);
        }}
      >
        <DownloadIcon />
        Install the app
      </button>
      {sheet && <IosSheet onClose={() => setSheet(false)} />}
    </>
  );
}

/** Add to Home Screen, step by step, as Safari (and Chrome) on iOS show it. */
function IosSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Install fr33world"
      kicker="iPhone"
      subtitle="The installed app is the way to play full screen, in landscape."
      size="sm"
      onClose={onClose}
      footer={
        <button type="button" className="m-btn go" onClick={onClose}>
          Got it
        </button>
      }
    >
      <ol className="install-steps">
        <li>
          <span className="install-icon">
            <ShareIcon />
          </span>
          <span>
            Tap <b>Share</b> in the browser's toolbar
          </span>
        </li>
        <li>
          <span className="install-icon">
            <AddIcon />
          </span>
          <span>
            Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>
          </span>
        </li>
        <li>
          <span className="install-icon">
            <img src="/brand/icon-192.png" alt="" />
          </span>
          <span>
            Open <b>fr33world</b> from your Home Screen
          </span>
        </li>
      </ol>
    </Modal>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** iOS's share icon: a box with an arrow out of the top. */
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M12 3v12M12 3 8 7m4-4 4 4M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2"
        stroke="#0a84ff"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Add to Home Screen's icon: a plus in a rounded square. */
function AddIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" stroke="#f4f6f8" strokeWidth="1.9" />
      <path d="M12 8.5v7M8.5 12h7" stroke="#f4f6f8" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}
