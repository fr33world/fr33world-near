/**
 * Recovering from a page older than the deploy. An installed app comes back from the
 * background as the page it was; when a newer build has been deployed since, that page's code
 * files are gone, so loading the game failed, and retrying failed again (browsers remember a
 * failed `import()`): only closing the app helped. A full reload fetches the current build.
 */

/** Was this a code file that couldn't be fetched (an old page after a deploy, or offline)? */
export function isStaleBuild(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch|Unable to preload|ChunkLoadError/i.test(
    text,
  );
}

const KEY = 'fr33world:reloadedAt';

/** Reloads the page, at most once in 30 s (so a page that can't load doesn't loop). */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Storage unavailable: reload anyway.
  }
  location.reload();
  return true;
}

/** "Try again": a fresh page, which loads the current build. */
export function retry(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  location.reload();
}
