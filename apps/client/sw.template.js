/**
 * fr33world's service worker (PWA), written into the build as /sw.js by vite.config.ts, which
 * fills in VERSION (changes with every build, so each deploy installs a new worker) and
 * PRECACHE (the page's entry files). Only same-origin GETs; the API, the world server and
 * Privy are never touched.
 *
 * - The page: network first, the saved copy when offline (the game then opens without a server).
 * - The build's hashed code: kept for good (a new build has new names); each new worker drops
 *   the previous build's.
 * - Models, textures, sounds, slides, fonts: the network first (the browser revalidates, so an
 *   unchanged file costs a tiny "not modified"), the saved copy when offline. They keep their
 *   names between deploys: serving the saved copy first showed players last deploy's files.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CODE = `fr33-code-${VERSION}`;
const FILES = 'fr33-files-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CODE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('fr33-code-') && k !== CODE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Vite's output: /assets/<name>-<hash>.<ext>, directly under /assets (models are in folders). */
const HASHED = /^\/assets\/[^/]+-[\w-]{8,}\.(js|css|wasm)$/;
const STATIC = /^\/(assets|brand|slides|fonts|basis)\//;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) void caches.open(CODE).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(() => caches.match('/', { cacheName: CODE }).then((r) => r ?? Response.error())),
    );
  } else if (HASHED.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) void caches.open(CODE).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
  } else if (STATIC.test(url.pathname) || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(FILES).then((cache) =>
        fetch(req)
          .then((res) => {
            if (res.ok && res.status === 200) void cache.put(req, res.clone());
            return res;
          })
          .catch(() => cache.match(req).then((hit) => hit ?? Response.error())),
      ),
    );
  }
});
