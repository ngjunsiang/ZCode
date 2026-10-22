// ZCode project-switch benchmark v2.
// B1: 12 warm switches (hover 120ms -> click, 2s settle)
// B3: cold first-visit + revisit of a cold-agent workspace
// B2: real streaming churn in /tmp/zcode-bench-ws (composer -> send -> 15s window)
import { writeFileSync } from 'node:fs';
import { chromium } from '/home/kureshii/ngjunsiang/ZCode/node_modules/playwright-core/index.mjs';

const WARM = [
  '/home/kureshii/ngjunsiang/ZCode',
  '/home/kureshii/ngjunsiang/HC-scans',
  '/home/kureshii/ngjunsiang/ontouchlite',
];
const FALLBACK_WARM = '/home/kureshii/ngjunsiang/ontouchlite';
const BENCH_WS = '/tmp/zcode-bench-ws';
const BENCH_NAME = 'zcode-bench-ws';
const ROW = (p) => `[data-testid="workspace-item-${p}"]`;
const TRIGGER = '[data-testid="composer-workspace-trigger"]';
const baseName = (p) => p.split('/').pop();

const browser = await chromium.connectOverCDP('http://127.0.0.1:9231');
const ctx = browser.contexts()[0];
// wait for the window page target (can lag the browser endpoint under load)
let page = null;
for (let i = 0; i < 60 && !page; i++) {
  const pages = ctx.pages();
  page = pages.find((p) => !p.url().startsWith('devtools')) ?? null;
  if (!page) await new Promise((r) => setTimeout(r, 2000));
}
if (!page) page = ctx.pages()[0];
if (!page) throw new Error('no page target');
if (page.url().startsWith('chrome-error') || page.url().startsWith('file:')) {
  await page.goto('http://[::1]:5174/?restoreSession=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
}
const ses = await ctx.newCDPSession(page);
// no bringToFront: the app runs on an isolated Xvfb display; focusing is irrelevant.

await page.waitForFunction(
  () => document.querySelectorAll('[data-testid^="workspace-item-"]').length >= 3,
  { timeout: 30000, polling: 500 },
);
await page.waitForTimeout(6000);

const { readFileSync } = await import('node:fs');
const log = readFileSync('/tmp/zcode-app.log', 'utf8');
const started = new Set([...log.matchAll(/agent process started.*?"workspaceKey":"([^"]+)"/g)].map((m) => m[1]));
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid^="workspace-item-"]')].map((el) =>
    el.getAttribute('data-testid').slice('workspace-item-'.length),
  ),
);
const COLD = rows.filter((p) => !started.has(p) && !WARM.includes(p)).sort()[0];
if (!COLD) throw new Error('no cold workspace candidate');
console.log('cold target:', COLD);

await page.evaluate(() => {
  window.__bench = { longtasks: [], switches: [] };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__bench.longtasks.push({ s: e.startTime, d: e.duration });
  }).observe({ type: 'longtask' });
});

async function armSwitch(target) {
  return page.evaluate(
    ({ sel, target }) => {
      const trigger = document.querySelector(sel);
      const rec = { target, wallClick: null, pageClick: null, pageTrigger: null };
      window.__bench.switches.push(rec);
      const idx = window.__bench.switches.length - 1;
      const onClick = () => {
        rec.pageClick = performance.now();
        rec.wallClick = Date.now();
      };
      document.addEventListener('click', onClick, { capture: true, once: true });
      if (!trigger) return idx;
      const before = trigger.textContent?.trim();
      const mo = new MutationObserver(() => {
        const t = trigger.textContent?.trim();
        if (t && t !== before && rec.pageTrigger == null) {
          rec.pageTrigger = performance.now();
          mo.disconnect();
        }
      });
      mo.observe(trigger, { subtree: true, characterData: true, childList: true });
      return idx;
    },
    { sel: TRIGGER, target },
  );
}

async function switchTo(path, { hoverMs = 120, waitMs = 8000, settleMs = 2000, label = '' } = {}) {
  const target = baseName(path);
  const recIdx = await armSwitch(target);
  const row = page.locator(ROW(path));
  await row.hover({ timeout: 6000 }).catch(() => {});
  if (hoverMs) await page.waitForTimeout(hoverMs);
  const wallBefore = Date.now();
  await row.click({ timeout: 6000 });
  let triggerDelta = null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const txt = await page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, TRIGGER);
    if (txt === target) {
      triggerDelta = Date.now() - wallBefore;
      break;
    }
    await page.waitForTimeout(40);
  }
  const result = {
    label: label || target,
    target,
    wallClick: wallBefore,
    recIdx,
    triggerDeltaWall: triggerDelta,
    timedOut: triggerDelta == null,
  };
  console.log(`${result.label}: trigger ${triggerDelta == null ? 'TIMEOUT>' + waitMs + 'ms' : triggerDelta + 'ms'}`);
  if (settleMs) await page.waitForTimeout(settleMs);
  return result;
}

const out = { phases: {}, switches: [], cold: COLD };

for (const t of WARM) await switchTo(t, { settleMs: 3500, label: 'warmup:' + baseName(t) });

// B1
out.phases.b1Start = Date.now();
for (let i = 0; i < 4; i++) {
  for (const t of WARM) {
    out.switches.push(await switchTo(t, { hoverMs: 120, settleMs: 2000, label: `b1#${out.switches.length}:${baseName(t)}` }));
  }
}
out.phases.b1End = Date.now();

// B3
out.phases.b3Start = Date.now();
out.switches.push(await switchTo(COLD, { hoverMs: 300, waitMs: 12000, settleMs: 12000, label: 'b3:cold-first' }));
out.switches.push(await switchTo(FALLBACK_WARM, { settleMs: 5000, label: 'b3:away' }));
out.switches.push(await switchTo(COLD, { hoverMs: 300, waitMs: 12000, settleMs: 3000, label: 'b3:cold-revisit' }));
out.phases.b3End = Date.now();

// B2: open bench workspace via second-instance argv, send one message, watch 15s
import { spawn } from 'node:child_process';
await spawn(
  '/home/kureshii/ngjunsiang/ZCode/node_modules/electron/dist/electron',
  ['.', '--open-workspace', BENCH_WS],
  {
    cwd: '/home/kureshii/ngjunsiang/ZCode/packages/desktop',
    env: {
      ...process.env,
      DISPLAY: ':99',
      ELECTRON_OZONE_PLATFORM_HINT: 'x11',
      ZCODE_DESKTOP_APPLICATION_NAME: 'Zcode Prof',
      ZCODE_DESKTOP_USER_DATA_DIR: '/tmp/zcode-prof-userdata',
    },
    detached: true,
    stdio: 'ignore',
  },
);
await page.waitForSelector(ROW(BENCH_WS), { timeout: 15000 });
await switchTo(BENCH_WS, { hoverMs: 300, waitMs: 10000, settleMs: 5000, label: 'b2:goto-bench-ws' });

const composer = page.locator('[data-testid="v4-composer"] [contenteditable="true"]').first();
await composer.click({ timeout: 8000 });
await page.keyboard.type('Reply with the numbers 1 to 15, one per line, then stop.', { delay: 8 });
await page.waitForTimeout(400);
out.phases.b2Send = Date.now();
await page.keyboard.press('Enter');
console.log('b2: message sent');
// streaming window
await page.waitForTimeout(15000);
out.phases.b2End = Date.now();
console.log('b2: window done');

// close the bench-ws tab to restore tab state
await page.locator(ROW(BENCH_WS)).hover({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(300);
await page.locator(`${ROW(BENCH_WS)} [data-testid^="workspace-close-"]`).click({ timeout: 5000 }).catch((e) => console.log('close tab failed:', String(e).slice(0, 80)));
await page.waitForTimeout(2000);
out.phases.benchEnd = Date.now();

const collectors = await page.evaluate(() => ({
  longtasks: window.__bench.longtasks,
  switches: window.__bench.switches,
}));
out.pageSwitches = collectors.switches;

const b2Rec = collectors.switches.find((r) => r.target === BENCH_NAME);
const b2PageWin = b2Rec?.pageClick != null ? [b2Rec.pageClick, b2Rec.pageClick + 25000] : null;
out.switchWindowLongtasks = out.switches.map((s) => {
  const rec = collectors.switches[s.recIdx];
  if (rec?.pageClick == null) return { label: s.label, count: 0, sum: 0, max: 0, noWindow: true };
  const [lo, hi] = [rec.pageClick, rec.pageClick + 3000];
  const inWin = collectors.longtasks.filter((t) => t.s >= lo && t.s <= hi);
  return { label: s.label, count: inWin.length, sum: Math.round(inWin.reduce((a, t) => a + t.d, 0)), max: Math.round(inWin.reduce((a, t) => Math.max(a, t.d), 0)) };
});
if (b2PageWin) {
  const inWin = collectors.longtasks.filter((t) => t.s >= b2PageWin[0] && t.s <= b2PageWin[1]);
  out.b2Longtasks = { count: inWin.length, sum: Math.round(inWin.reduce((a, t) => a + t.d, 0)), max: Math.round(inWin.reduce((a, t) => Math.max(a, t.d), 0)) };
}

writeFileSync('/tmp/zcode-prof/bench-out.json', JSON.stringify(out, null, 1));
const sums = out.switchWindowLongtasks.filter((w) => w.label.startsWith('b1#')).map((w) => w.sum).sort((a, b) => a - b);
console.log('\nB1 blocked-ms/switch:', sums.join(','), 'median', sums[Math.floor(sums.length / 2)]);
console.log('B2 longtasks:', JSON.stringify(out.b2Longtasks));
console.log('done.');
await browser.close();
