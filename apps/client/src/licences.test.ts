/**
 * The asset licence audit (Phase 12): every file the client ships under public/assets and
 * public/ui is covered by an entry in assets/registry.yaml (a file, a brace list, or its
 * folder), and every entry points at a licence snapshot that exists. Renders made from the
 * game's own registered models (ui/cars, ui/emotes, ui/tutorial) count as their sources'.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const registry = readFileSync(join(root, 'assets/registry.yaml'), 'utf8');

/** Files under public/assets in git (what deploys; local test copies aren't). */
function shippedAssets(): string[] {
  const out = execFileSync('git', ['ls-files', 'apps/client/public/assets'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^apps\/client\/public\/assets\//, ''));
}

/** "a{x,y}b{0..2}" → every combination. */
function expand(f: string): string[] {
  const brace = /\{([^}]+)\}/.exec(f);
  if (!brace) return [f];
  const body = brace[1] ?? '';
  const range = /^(\d+)\.\.(\d+)$/.exec(body);
  const parts = range
    ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) =>
        String(Number(range[1]) + i),
      )
    : body.split(',').map((p) => p.trim());
  return parts.flatMap((p) => expand(f.replace(brace[0], p)));
}

/** Every path an entry's `file` names. */
function covered(): string[] {
  return [...registry.matchAll(/^\s+file:\s*'?([^'\n]+?)'?\s*$/gm)].flatMap((m) =>
    expand((m[1] ?? '').trim()),
  );
}

describe('asset licences', () => {
  it('registers every shipped model, texture, sound and animation', () => {
    const known = covered();
    const shipped = shippedAssets();
    const missing = shipped.filter(
      (f) =>
        !known.includes(f) &&
        // Detail levels and masks travel with their registered model.
        !known.includes(f.replace(/\.lod\d\.glb$/, '.glb')) &&
        !known.includes(f.replace(/\.mask\.png$/, '.glb')) &&
        // KTX2 versions of registered textures (scripts/assets/city-ktx2.mjs).
        !known.includes(f.replace(/\.ktx2$/, '.webp')) &&
        !/^characters\/rocketbox\.json$/.test(f) &&
        !/\.gitkeep$/.test(f),
    );
    expect(missing).toEqual([]);
  });

  it('has a licence snapshot for every entry', () => {
    const snapshots = [...registry.matchAll(/license_snapshot:\s*'?([^'\s]+)'?/g)].map((m) => m[1]);
    expect(snapshots.length).toBeGreaterThan(10);
    for (const s of new Set(snapshots))
      expect(existsSync(join(root, 'assets/licenses', s ?? '')), s).toBe(true);
  });
});
