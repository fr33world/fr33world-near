import { PrivyProvider } from '@privy-io/react-auth';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { wakeApi } from './game/api.ts';
import { installErrorReporting } from './game/report.ts';
import { wakeServer } from './game/server.ts';
import { registerServiceWorker } from './ui/Install.tsx';
import { reloadOnce } from './ui/stale.ts';
import './ui/ui.css';

installErrorReporting();

// An old page after a deploy: a code file Vite preloads is gone. A reload gets the new build.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  reloadOnce();
});

// The splash (index.html) stays at least 1.5 s, then fades once the app has drawn.
const splashFrom = performance.now();
const hideSplash = () => {
  const el = document.getElementById('splash');
  if (!el) return;
  window.setTimeout(
    () => {
      el.classList.add('gone');
      window.setTimeout(() => el.remove(), 600);
    },
    Math.max(0, 1500 - (performance.now() - splashFrom)),
  );
};
requestAnimationFrame(() => requestAnimationFrame(hideSplash));

// The page never scrolls (index.html pins it), but iOS still scrolls it when the keyboard
// opens or the phone turns, and may leave it there: put it back whenever that's over.
const unscroll = () => {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
  if (document.body.scrollTop) document.body.scrollTop = 0;
};
/**
 * The iPhone home-screen app opened upright and then turned keeps the upright status bar's
 * height off the page: a black strip under the game (owner, 2026-10-30). Scrolling back
 * doesn't cure it; setting the viewport again makes iOS measure the screen afresh.
 */
const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
const viewport = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
const refit = () => {
  if (!standalone || !viewport) return;
  const content = viewport.content;
  viewport.content = `${content}, height=device-height`;
  requestAnimationFrame(() => {
    viewport.content = content;
    unscroll();
  });
};
const settle = () => {
  unscroll();
  // iOS finishes its own layout a moment after the event.
  window.setTimeout(unscroll, 120);
  window.setTimeout(unscroll, 500);
};
// On opening and after each turn (not on every resize: setting the viewport is one).
refit();
window.addEventListener('focusout', settle);
window.addEventListener('orientationchange', () => {
  settle();
  window.setTimeout(refit, 600);
});
// Back from the background (the app switcher) it can open measured wrong too.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) window.setTimeout(refit, 300);
});
window.addEventListener('resize', settle);
window.addEventListener('scroll', unscroll, { passive: true });
window.visualViewport?.addEventListener('resize', settle);
// The installed app (PWA): works offline and opens instantly (production builds).
registerServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
// Privy needs a secure origin (HTTPS or localhost) and throws on others, such as phones on the
// dev server's LAN address, so it only loads there; elsewhere the game runs without a login.
const appId = window.isSecureContext
  ? (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)
  : undefined;

// Start waking the world server and the API now (free hosting sleeps when idle) so they're up
// by the time the player is through the login and the city has loaded.
if (!new URLSearchParams(location.search).has('offline')) {
  void wakeServer().catch(() => {});
  if (appId) void wakeApi().catch(() => {});
}

createRoot(root).render(
  appId ? (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email', 'google', 'discord', 'twitter'],
        appearance: { theme: 'dark', accentColor: '#7def06', logo: '/brand/wordmark.webp' },
        // Solana wallets for car certificates are created after login for real accounts only
        // (LoginScreen): guests hold no on-chain assets (D-14), and Privy can't make guests
        // a wallet anyway, which left their login hanging. No Ethereum wallets.
        embeddedWallets: {
          solana: { createOnLogin: 'off' },
          ethereum: { createOnLogin: 'off' },
        },
      }}
    >
      <App loginEnabled />
    </PrivyProvider>
  ) : (
    <App loginEnabled={false} />
  ),
);
