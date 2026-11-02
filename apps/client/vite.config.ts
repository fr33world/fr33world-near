import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** What the installed app keeps from the first visit, besides the page's own code. */
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/brand/emblem.webp',
  '/brand/wordmark.webp',
  '/fonts/barlow-600.woff2',
  '/fonts/barlow-700.woff2',
  '/fonts/bebas-neue.woff2',
  '/slides/downtown.webp',
];

/**
 * Writes the service worker (sw.template.js) into the build as /sw.js, with this build's
 * version (from its file names, so every deploy installs a new worker) and the files to keep
 * on install: the shell above and the page's entry code.
 */
function serviceWorker(): Plugin {
  return {
    name: 'fr33-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entry: string[] = [];
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.isEntry) {
          entry.push(
            `/${file.fileName}`,
            ...[...(file.viteMetadata?.importedCss ?? [])].map((c) => `/${c}`),
          );
        }
      }
      const version = createHash('sha256')
        .update(Object.keys(bundle).sort().join('\n'))
        .digest('hex')
        .slice(0, 12);
      const source = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify([...SHELL, ...entry]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  // Shared .env at the repo root; only VITE_* variables reach the browser.
  envDir: '../..',
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  // Rapier's compat build embeds its WASM; keep it out of dependency pre-bundling.
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
