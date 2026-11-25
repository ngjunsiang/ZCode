// Cold-visit benchmark for opt 4 (hover pre-warm). v2
// Per cold target: settle fully, kill dev-app agent CLIs (force genuine cold agent),
// hover row 1000ms (realistic dwell), click, measure click->sidebar-active-highlight.
// Completion signal = active row background (independent of composer state).
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from '/home/kureshii/ngjunsiang/ZCode/node_modules/playwright-core/index.mjs';

const WARM = [
  '/home/kureshii/ngjunsiang/ZCode',
  '/home/kureshii/ngjunsiang/HC-scans',
  '/home/kureshii/ngjunsiang/ontouchlite',
];
const ROW = (p) => `[data-testid="workspace-item-${p}"]`;
const TRIGGER = '[data-testid="composer-workspace-trigger"]';
const baseName = (p) => p.split('/').pop();

function childrenOf(pid) {
  const out = [];
  for (const ent of readdirSync('/proc')) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const stat = readFileSync(`/proc/${ent}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2);
      const ppid = Number(after.split(' ')[1]);
      if (ppid === pid) out.push(Number(ent));
    } catch {}
  }
  return out;
}
function descendantsOf(pid) {
  const all = [];
  const walk = (p) => {
    for (const c of childrenOf(p)) {
      all.push(c);
      walk(c);
    }
  };
  walk(pid);
  return all;
}
function killDevAgents() {
  const pidOut = execSync(`ps -eo pid,args | awk '$2=="Zcode" && $3=="Prof" {print $1; exit}'`, {
    encoding: 'utf8',
  }).trim();
  if (!pidOut) return { host: null, killed: [], error: 'no Zcode Prof main process' };
  const desc = descendantsOf(Number(pidOut));
  const hostEntry = desc.find((p) => {
    try {
      // /proc/<pid>/comm is truncated to 15 chars: "zcode-host-loca"
      return readFileSync(`/proc/${p}/comm`, 'utf8').trim().startsWith('zcode-host-loca');
    } catch {
      return false;
    }
  });
  if (!hostEntry) return { host: null, killed: [], error: 'no dev host among descendants' };
  const procs = descendantsOf(hostEntry);
  for (const p of procs) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
  return { host: hostEntry, killed: procs };
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9231');
const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 30 && !page; i++) {
  page = ctx.pages().find((p) => !p.url().startsWith('devtools')) ?? null;
  if (!page) await new Promise((r) => setTimeout(r, 2000));
}
if (!page) throw new Error('no page target');
if (page.url().startsWith('chrome-error') || page.url().startsWith('file:')) {
  await page.goto('http://[::1]:5174/?restoreSession=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
}
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid^="workspace-item-"]').length >= 3,
  { timeout: 60000, polling: 500 },
);
// generous settle: restore spawns agents; killing during that races the process manager
await page.waitForTimeout(20000);

const log = readFileSync('/tmp/zcode-app.log', 'utf8');
const started = new Set([...log.matchAll(/agent process started[^{]*\{\s*"workspaceKey":"([^"]+)"/g)].map((m) => m[1]));
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid^="workspace-item-"]')].map((el) =>
    el.getAttribute('data-testid').slice('workspace-item-'.length),
  ),
);
const coldTargets = rows.filter((p) => !started.has(p) && !WARM.includes(p) && !p.includes('bench-ws')).sort().slice(0, 2);
if (coldTargets.length < 2) throw new Error('need 2 cold targets, got: ' + coldTargets.join(','));
console.log('cold targets:', coldTargets.join(' , '));

// warmup click on a stable WARM workspace; verify the trigger text moved there
async function triggerText() {
  return page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, TRIGGER);
}
await page.locator(ROW(WARM[0])).click({ timeout: 10000 });
for (let i = 0; i < 20 && (await triggerText()) !== baseName(WARM[0]); i++) await page.waitForTimeout(500);
console.log('warmup trigger:', await triggerText());
await page.waitForTimeout(5000);

const out = { visits: [], targets: coldTargets, phases: { start: Date.now() } };

for (const target of coldTargets) {
  const k = killDevAgents();
  console.log(`killed ${k.killed.length} agent processes under host ${k.host} for ${baseName(target)}`);
  // settle: respawns + subscription retries after the kill must finish before clicking
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const tail = execSync('tail -c 200000 /tmp/zcode-app.log | grep -vE "host-log|writing settings" | tail -60', { encoding: 'utf8' });
    const recent = /agent process (start|exit)/.test(tail.split('\n').slice(-12).join('\n'));
    if (!recent) break;
  }
  await new Promise((r) => setTimeout(r, 1500));

  const row = page.locator(ROW(target));
  await row.scrollIntoViewIfNeeded({ timeout: 10000 });
  const hoverWall = Date.now();
  await row.hover({ timeout: 10000 });
  await page.waitForTimeout(1000); // realistic dwell
  const wallBefore = Date.now();
  await row.click({ timeout: 10000 });
  // completion = composer trigger shows target; one re-click recovery after 8s
  let triggerDelta = null;
  for (let attempt = 0; attempt < 2 && triggerDelta == null; attempt++) {
    const deadline = Date.now() + (attempt === 0 ? 8000 : 12000);
    while (Date.now() < deadline) {
      if ((await triggerText()) === baseName(target)) {
        triggerDelta = Date.now() - wallBefore;
        break;
      }
      await page.waitForTimeout(60);
    }
    if (triggerDelta == null && attempt === 0) {
      console.log(`${baseName(target)}: no switch after 8s, re-clicking once`);
      await page.locator(ROW(target)).click({ timeout: 8000 }).catch(() => {});
    }
  }
  const rec = {
    target: baseName(target),
    hoverWall,
    wallClick: wallBefore,
    triggerDeltaWall: triggerDelta,
    timedOut: triggerDelta == null,
    hoverToClickMs: wallBefore - hoverWall,
    killedAgents: k.killed.length,
  };
  out.visits.push(rec);
  console.log(`${rec.target}: trigger ${rec.timedOut ? 'TIMEOUT' : rec.triggerDeltaWall + 'ms'}`);
  await page.waitForTimeout(6000);
}
out.phases.end = Date.now();
writeFileSync('/tmp/zcode-prof/bench-cold-out.json', JSON.stringify(out, null, 1));
console.log('done.');
await browser.close();
