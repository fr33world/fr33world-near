#!/usr/bin/env node
/**
 * Size budgets (Phase 2): fails when the client's code or assets outgrow what a first visit on
 * mobile data can afford. Limits sit about 10% over today's sizes, so raising one is a decision.
 * Run after `vite build`, in CI too; rbtest/ is a dev page's data, which players never load.
 *
 *   node scripts/assets/budgets.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const client = resolve(import.meta.dirname, '../../apps/client');
const dist = join(client, 'dist');
const assets = join(client, 'public/assets');
const KB = 1024;
const MB = 1024 * KB;

/** Compressed, as a player downloads it. */
const code = {
  'game chunk': { files: /^Game-.*\.js$/, limit: 1.82 * MB },
  'character chunk': { files: /^character-.*\.js$/, limit: 230 * KB },
};
/** Compressed: index.html and all it loads up front, which is mostly Privy. */
const LOGIN_SCREEN = 665 * KB;
/** On disk (already compressed formats), by folder of public/assets. */
const folders = {
  animations: { limit: 10.2 * MB, file: 1.8 * MB },
  audio: { limit: 2.2 * MB, file: 2.1 * MB },
  cars: { limit: 7.4 * MB, file: 1.5 * MB },
  characters: { limit: 118 * MB, file: 1.9 * MB },
  props: { limit: 520 * KB, file: 180 * KB },
  textures: { limit: 19.5 * MB, file: 750 * KB },
};

const size = (n) => (n >= MB ? `${(n / MB).toFixed(2)} MB` : `${Math.round(n / KB)} KB`);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

if (!existsSync(join(dist, 'index.html'))) {
  console.error('No apps/client/dist: run `pnpm --filter @fr33world/client build` first.');
  process.exit(2);
}
const failures = [];
const check = (name, value, limit) => {
  const over = value > limit;
  console.log(`${over ? 'OVER' : 'ok  '} ${name.padEnd(46)} ${size(value)} of ${size(limit)}`);
  if (over) failures.push(name.trim());
};

const gz = (file) => gzipSync(readFileSync(file)).length;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
check(
  'login screen',
  entry.reduce((sum, f) => sum + gz(join(dist, f)), gz(join(dist, 'index.html'))),
  LOGIN_SCREEN,
);
const built = readdirSync(join(dist, 'assets'));
for (const [name, { files, limit }] of Object.entries(code)) {
  const found = built.filter((f) => files.test(f));
  if (found.length === 0) failures.push(`${name}: no file matches ${files}`);
  check(
    name,
    found.reduce((sum, f) => sum + gz(join(dist, 'assets', f)), 0),
    limit,
  );
}
for (const [name, { limit, file }] of Object.entries(folders)) {
  const sizes = walk(join(assets, name)).map((f) => [f, statSync(f).size]);
  check(
    `assets/${name}`,
    sizes.reduce((sum, [, n]) => sum + n, 0),
    limit,
  );
  const [largest, n] = sizes.reduce((a, b) => (b[1] > a[1] ? b : a));
  check(`  largest: ${largest.slice(assets.length + 1)}`, n, file);
}

if (failures.length > 0) {
  console.error(`\nOver budget: ${failures.join(', ')}`);
  process.exit(1);
}
