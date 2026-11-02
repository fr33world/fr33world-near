#!/usr/bin/env node
/**
 * Screenshots the running client in headless Chrome over the DevTools protocol.
 *   node scripts/shot.mjs <url> <out.png> [width] [height] [settleMs] [script]
 * Clicks through TAP TO PLAY (SHOT_NO_TAP=1 doesn't), waits for document.body.dataset.ready ===
 * '1' (world loaded; skip with SHOT_NO_WAIT=1; SHOT_MOBILE=1 emulates a touch phone, SHOT_SLOW=1 a
 * slow connection, SHOT_UA another user agent, SHOT_EVAL prints an expression), runs the
 * optional JS `script`
 * in the page (e.g. to drive window.__fr33.input), then lets frames settle.
 */
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const [url, out, width = '1280', height = '720', settle = '2500', script = ''] =
  process.argv.slice(2);
if (!url || !out) {
  console.error('usage: shot.mjs <url> <out.png> [width] [height] [settleMs]');
  process.exit(2);
}
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    // Headless Chrome on this Mac can't create a GPU WebGL context; SwiftShader is slow but works.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=/tmp/claude-501/chrome-${port}`,
    `--window-size=${width},${height}`,
    // SHOT_FAKE_MEDIA=1: a fake microphone (a beep) and no permission prompt, for voice tests.
    ...(process.env.SHOT_FAKE_MEDIA
      ? [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
        ]
      : []),
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let targets;
  for (let i = 0; i < 50 && !targets; i += 1) {
    await sleep(200);
    targets = await fetch(`http://127.0.0.1:${port}/json`).then(
      (r) => r.json(),
      () => undefined,
    );
  }
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome://'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (
      msg.method === 'Runtime.consoleAPICalled' ||
      msg.method === 'Runtime.exceptionThrown'
    ) {
      logs.push(JSON.stringify(msg.params).slice(0, 400));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  // SHOT_MOBILE=1: a touch phone (touch controls instead of key hints).
  const mobile = Boolean(process.env.SHOT_MOBILE);
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: 1,
    mobile,
  });
  if (mobile)
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // SHOT_SLOW=1: a slow mobile connection (about 3 Mbit/s), to see loading screens.
  if (process.env.SHOT_SLOW) {
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 120,
      downloadThroughput: 380_000,
      uploadThroughput: 100_000,
    });
  }
  // SHOT_UA=…: another browser's user agent (e.g. an iPhone's, for iOS-only screens).
  if (process.env.SHOT_UA)
    await send('Emulation.setUserAgentOverride', { userAgent: process.env.SHOT_UA });
  // SHOT_BLOCK=pattern: requests matching it fail (error screens).
  if (process.env.SHOT_BLOCK) {
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: [process.env.SHOT_BLOCK] });
  }
  // Past TAP TO PLAY as a player would (SHOT_NO_TAP=1 stops there, to see the boot screen).
  if (!process.env.SHOT_NO_TAP) {
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `setInterval(() => document.querySelector('.tap-to-play')?.click(), 200);`,
    });
  }
  // SHOT_TRANSPARENT=1: no white behind the page, so a clear canvas stays clear (pictures).
  if (process.env.SHOT_TRANSPARENT)
    await send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
  await send('Page.navigate', { url });
  const started = Date.now();
  // SHOT_NO_WAIT=1: screens before the game (login) never set the ready marker.
  for (; !process.env.SHOT_NO_WAIT;) {
    const r = await send('Runtime.evaluate', {
      expression: 'document.body?.dataset.ready === "1"',
      returnByValue: true,
    });
    if (r.result?.result?.value === true) break;
    if (Date.now() - started > Number(process.env.SHOT_READY_MS ?? 60_000)) {
      console.error(logs.join('\n'));
      throw new Error('page never became ready');
    }
    await sleep(250);
  }
  if (script) await send('Runtime.evaluate', { expression: script });
  // SHOT_PROFILE=ms: a CPU profile of the page for that long; prints the functions that took
  // the most time themselves (and their share), to find what a frame spends its time on.
  if (process.env.SHOT_PROFILE) {
    // SHOT_PROFILE_DELAY=ms: let loading-time work (shader compiles) finish first.
    await sleep(Number(process.env.SHOT_PROFILE_DELAY ?? 0));
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 200 });
    await send('Profiler.start');
    const frames0 = await send('Runtime.evaluate', {
      expression: 'window.__fr33?.frameCount ?? 0',
      returnByValue: true,
    });
    await sleep(Number(process.env.SHOT_PROFILE));
    const frames1 = await send('Runtime.evaluate', {
      expression: 'window.__fr33?.frameCount ?? 0',
      returnByValue: true,
    });
    const { result } = await send('Profiler.stop');
    const prof = result.profile;
    const dt = [];
    for (let i = 0; i < prof.timeDeltas.length; i += 1) dt.push(prof.timeDeltas[i]);
    const selfTime = new Map();
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    prof.samples.forEach((sid, i) => {
      const n = byId.get(sid);
      const f = n.callFrame;
      const file = (f.url.split('/').pop() || '').split('?')[0];
      const key = `${f.functionName || '(anon)'} ${file}:${f.lineNumber + 1}`;
      selfTime.set(key, (selfTime.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    const total = [...selfTime.values()].reduce((a, b) => a + b, 0);
    const frames = (frames1.result?.result?.value ?? 0) - (frames0.result?.result?.value ?? 0);
    console.log(`PROFILE ${total.toFixed(0)} ms sampled, ${frames} frames`);
    for (const [k, v] of [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40))
      console.log(
        `  ${v.toFixed(1).padStart(8)} ms ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`,
      );
  }
  await sleep(Number(settle));
  const info = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({ stats: window.__fr33?.stats, hud: window.__fr33?.hud })',
    returnByValue: true,
  });
  // SHOT_BEFORE=expression: run it first (open a menu, move the camera), awaited.
  if (process.env.SHOT_BEFORE) {
    await send('Runtime.evaluate', {
      expression: process.env.SHOT_BEFORE,
      awaitPromise: true,
    });
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${out}`, info.result?.result?.value ?? '');
  // SHOT_EVAL=expression: print its value (dev pages that measure things).
  if (process.env.SHOT_EVAL) {
    const r = await send('Runtime.evaluate', {
      expression: process.env.SHOT_EVAL,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(`EVAL ${JSON.stringify(r.result?.result?.value)}`);
  }
  if (logs.length) console.log(logs.slice(0, 80).join('\n'));
  ws.close();
} finally {
  proc.kill();
  // Its throwaway Chrome profile (tens of MB) goes with it: hundreds of runs filled the disk.
  await new Promise((r) => proc.once('exit', r));
  rmSync(`/tmp/claude-501/chrome-${port}`, { recursive: true, force: true });
}
