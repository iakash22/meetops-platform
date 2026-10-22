/* global process, console, setTimeout, fetch, URL, chrome */
// Real-gesture end-to-end test: headed Chromium (Playwright's build) + the built extension.
// Opens the popup with the extension's keyboard shortcut (Alt+Shift+M, sent by xdotool as a real
// X11 key event, so Chrome treats it as a user gesture that grants activeTab / tabCapture),
// acknowledges consent, starts recording, and asserts: state 'recording' with >= 2 chunks,
// badge 'REC', chrome.tabCapture.getCapturedTabs() reports the consented tab; then stops and
// asserts idle + cleared badge.
//
// Usage: pnpm test:e2e   (builds first). Needs: xdotool, and Xvfb when $DISPLAY is unset
// (started automatically), plus `pnpm exec playwright install --with-deps chromium`.
// Env: E2E_ATTEMPTS (default 2) whole-run attempts; E2E_EXT_DIR to override the build dir.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(process.env.E2E_EXT_DIR ?? path.join(here, '..', 'dist', 'chrome-mv3'));
const ATTEMPTS = Number(process.env.E2E_ATTEMPTS ?? 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

function assert(cond, msg, extra) {
  if (!cond) throw new Error(`${msg}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
}

async function poll(fn, { timeout = 10_000, every = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${String(last)})`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function ensureDisplay(cleanups) {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  for (let n = 90 + Math.floor(Math.random() * 400); ; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const x = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    cleanups.push(() => x.kill());
    await poll(() => existsSync(`/tmp/.X11-unix/X${n}`), { timeout: 10_000, what: 'Xvfb' });
    log(`started Xvfb on :${n}`);
    return `:${n}`;
  }
}

const PAGE = `<!doctype html><title>MeetOps e2e meeting</title><h1>Meeting tab</h1>
<button id="tone" onclick="const c=new AudioContext();const o=c.createOscillator();o.connect(c.destination);o.start();this.textContent='playing'">tone</button>`;

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function runOnce() {
  const cleanups = [];
  try {
    assert(
      existsSync(path.join(EXT, 'manifest.json')),
      `No built extension at ${EXT}; run pnpm build`,
    );
    const display = await ensureDisplay(cleanups);
    const env = { ...process.env, DISPLAY: display };

    const server = http.createServer((_q, r) =>
      r.writeHead(200, { 'content-type': 'text/html' }).end(PAGE),
    );
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => server.close());
    const pageUrl = `http://127.0.0.1:${server.address().port}/`;

    const port = await freePort();
    const profile = mkdtempSync(path.join(tmpdir(), 'meetops-e2e-'));
    cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
    const browserProc = spawn(
      chromium.executablePath(),
      [
        `--user-data-dir=${profile}`,
        `--load-extension=${EXT}`,
        `--disable-extensions-except=${EXT}`,
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1200,760',
        '--window-position=0,0',
        ...(process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : []),
        pageUrl,
      ],
      { env, stdio: 'ignore' },
    );
    cleanups.push(() => browserProc.kill('SIGKILL'));

    await poll(async () => (await targets(port)).some((t) => t.url === pageUrl), {
      timeout: 20_000,
      what: 'browser + meeting tab',
    });
    let b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    cleanups.push(() => b.close().catch(() => undefined));
    const page = b
      .contexts()[0]
      .pages()
      .find((p) => p.url() === pageUrl);
    assert(page, 'meeting tab not found');
    await page.click('#tone');

    // Open the popup with a real keyboard gesture; detect it via CDP targets; retry.
    let popupTarget;
    for (let attempt = 1; attempt <= 6 && !popupTarget; attempt++) {
      const win = execFileSync(
        'xdotool',
        ['search', '--sync', '--onlyvisible', '--name', 'MeetOps e2e meeting'],
        { env },
      )
        .toString()
        .trim()
        .split('\n')
        .pop();
      try {
        execFileSync('xdotool', ['windowfocus', '--sync', win], { env });
      } catch {
        /* no window manager: focus via click below */
      }
      execFileSync('xdotool', ['mousemove', '--window', win, '400', '400', 'click', '1'], { env });
      await sleep(300);
      execFileSync('xdotool', ['key', '--clearmodifiers', 'alt+shift+m'], { env });
      popupTarget = await poll(
        async () => (await targets(port)).find((t) => t.url.endsWith('/popup.html')),
        { timeout: 4000, what: 'popup' },
      ).catch(() => undefined);
      if (!popupTarget) log(`popup not open after attempt ${attempt}, retrying`);
    }
    assert(popupTarget, 'popup never opened via Alt+Shift+M');
    const extId = new URL(popupTarget.url).host;

    // A fresh CDP connection sees the popup page and the service worker.
    await b.close().catch(() => undefined);
    b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    cleanups.push(() => b.close().catch(() => undefined));
    const ctx = b.contexts()[0];
    const pop = ctx.pages().find((p) => p.url().endsWith('/popup.html'));
    assert(pop, 'popup page not attachable');
    const sw =
      ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`)) ??
      (await ctx.waitForEvent('serviceworker', { timeout: 10_000 }));

    await pop.getByText('Record this meeting').click();
    await pop.getByText('I understand and have consent').click();
    await pop.getByText('Start recording').click();

    const readState = () =>
      sw.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder);
    const state = await poll(
      async () => {
        const s = await readState();
        if (s?.status === 'idle') throw new Error(`went idle: ${s.lastError ?? ''}`);
        return s?.status === 'recording' && s.chunks >= 2 ? s : false;
      },
      { timeout: 30_000, every: 500, what: "'recording' with >= 2 chunks" },
    );
    const tabId = await sw.evaluate(
      async (u) => (await chrome.tabs.query({ url: u }))[0]?.id,
      pageUrl,
    );
    assert(state.tabId === tabId, 'recording bound to the wrong tab', { state, tabId });
    const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    assert(badge === 'REC', 'badge should be REC while recording', badge);
    const captured = await sw.evaluate(
      () => new Promise((r) => chrome.tabCapture.getCapturedTabs(r)),
    );
    assert(
      captured.some((c) => c.tabId === tabId && c.status === 'active'),
      'getCapturedTabs does not report the consented tab',
      captured,
    );
    log(`recording ok: tab ${tabId}, ${state.chunks} chunks, badge ${badge}`);

    await pop.getByText('Stop recording').click();
    const after = await poll(
      async () => ((await readState())?.status === 'idle' ? readState() : false),
      {
        timeout: 15_000,
        what: 'idle after stop',
      },
    );
    assert(!after.lastError, 'stop produced an error', after);
    const badgeAfter = await sw.evaluate(() => chrome.action.getBadgeText({}));
    assert(badgeAfter === '', 'badge should clear after stop', badgeAfter);
    log('stop ok: idle, badge cleared');
  } finally {
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        /* ignore */
      }
    }
  }
}

for (let i = 1; i <= ATTEMPTS; i++) {
  try {
    await runOnce();
    log(`PASS (attempt ${i}/${ATTEMPTS})`);
    process.exit(0);
  } catch (e) {
    console.error(`[e2e] attempt ${i}/${ATTEMPTS} failed:`, e instanceof Error ? e.message : e);
  }
}
console.error('[e2e] FAIL');
process.exit(1);
