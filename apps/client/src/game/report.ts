/**
 * Sends uncaught errors to the game API (/v1/errors), where repeats are grouped. At most ten
 * reports per session and each message once, so a broken frame loop can't flood anything.
 * Off in development (errors show in the console there).
 */
import { apiUrl } from './api.ts';

const MAX_REPORTS = 10;
const BUILD = (import.meta.env.VITE_BUILD as string | undefined) ?? 'dev';
const seen = new Set<string>();

export function reportError(error: unknown, context = ''): void {
  if (import.meta.env.DEV || seen.size >= MAX_REPORTS) return;
  const err = error instanceof Error ? error : null;
  const message = `${context ? `${context}: ` : ''}${err ? err.message : String(error)}`.slice(
    0,
    500,
  );
  if (!message || seen.has(message)) return;
  seen.add(message);
  void fetch(`${apiUrl()}/v1/errors`, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, stack: err?.stack ?? '', url: location.href, build: BUILD }),
  }).catch(() => {});
}

export function installErrorReporting(): void {
  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'unhandled'));
}
