// Extract host-side metrics from /tmp/zcode-app.log correlated with bench-out.json timestamps.
import { readFileSync, writeFileSync } from 'node:fs';

const config = process.argv[2] || 'unknown';
const bench = JSON.parse(readFileSync('/tmp/zcode-prof/bench-out.json', 'utf8'));
const log = readFileSync('/tmp/zcode-app.log', 'utf8');

// parse log lines into {t: epochMs, pid, tag, rest} — host-origin lines only ([pid:HOST] without [main])
const HOST_PID = (() => {
  const m = log.match(/\[pid:(\d+)\] \[zcode-host\] \[rpc:call\]/);
  return m?.[1];
})();
const lines = [];
for (const line of log.split('\n')) {
  if (line.includes('[host-log]')) continue; // main-forwarded duplicates
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\] \[pid:(\d+)\] \[([a-z-]+)\] (.*)$/);
  if (!m) continue;
  const t = new Date(`${m[1]}T${m[2]}.${m[3]}+08:00`).getTime();
  lines.push({ t, rest: m[6] });
}
const inWindow = (t) => t >= bench.phases.b1Start - 2000 && t <= bench.phases.benchEnd + 1000;

const rpcCalls = [];
for (const l of lines) {
  const m = l.rest.match(/\[rpc:call\] (\S+) OK \(([0-9.]+)ms\)/);
  if (m) rpcCalls.push({ t: l.t, method: m[1], ms: parseFloat(m[2]) });
}
const count = (method, from = bench.phases.b1Start - 2000) =>
  rpcCalls.filter((c) => c.method === method && c.t >= from && c.t <= bench.phases.benchEnd + 1000).length;
const durs = (method) =>
  rpcCalls.filter((c) => c.method === method && inWindow(c.t)).map((c) => c.ms);

const spawns = [];
for (const l of lines) {
  if (l.rest.includes('agent process started')) {
    const w = l.rest.match(/"workspaceKey":"([^"]+)"/);
    spawns.push({ t: l.t, ws: w?.[1] ?? '?' });
  }
}
const prepares = [];
for (const l of lines) {
  if (l.rest.includes('workspace prepare start')) {
    const w = l.rest.match(/"workspacePath":"([^"]+)"/);
    prepares.push({ t: l.t, ws: w?.[1] ?? '?', kind: 'start' });
  }
  if (l.rest.includes('readWorkspacePresentation done')) {
    const w = l.rest.match(/"workspacePath":"([^"]+)"/);
    const d = l.rest.match(/"readPresentationDurationMs":(\d+)/);
    prepares.push({ t: l.t, ws: w?.[1] ?? '?', kind: 'done', ms: d ? +d[1] : null });
  }
}

const b3Click = (label) => bench.switches.find((s) => s.label === label);
const coldName = bench.cold.split('/').pop();
const b3First = b3Click('b3:cold-first');
const b3Revisit = b3Click('b3:cold-revisit');
const prepareOffset = (click) => {
  if (!click) return null;
  const p = prepares.filter((x) => x.ws === bench.cold && x.kind === 'start' && x.t >= click.wallClick - 2000 && x.t <= click.wallClick + 15000);
  return p.length ? p[0].t - click.wallClick : null;
};
const readDur = (click) => {
  if (!click) return null;
  const p = prepares.filter((x) => x.ws === bench.cold && x.kind === 'done' && x.t >= click.wallClick && x.t <= click.wallClick + 20000);
  return p.length ? p[p.length - 1].ms : null;
};

const gitDurs = durs('git.refresh');
const b1Wins = (bench.switchWindowLongtasks ?? []).filter((w) => w.label.startsWith('b1#'));
const sums = b1Wins.map((w) => w.sum).sort((a, b) => a - b);
const triggers = bench.switches.filter((s) => s.label.startsWith('b1#') && s.triggerDeltaWall != null).map((s) => s.triggerDeltaWall).sort((a, b) => a - b);

const result = {
  config,
  cold: bench.cold,
  b1: {
    switches: b1Wins.length,
    blockedMsPerSwitch: sums,
    blockedMedian: sums.length ? sums[Math.floor(sums.length / 2)] : null,
    blockedMax: sums.length ? Math.max(...sums) : null,
    triggerMedian: triggers.length ? triggers[Math.floor(triggers.length / 2)] : null,
    triggerCount: triggers.length,
  },
  b3: {
    firstTriggerMs: b3First?.triggerDeltaWall ?? 'timeout',
    revisitTriggerMs: b3Revisit?.triggerDeltaWall ?? 'timeout',
    firstPrepareOffsetMs: prepareOffset(b3First),
    revisitPrepareOffsetMs: prepareOffset(b3Revisit),
    firstReadDurMs: readDur(b3First),
    revisitReadDurMs: readDur(b3Revisit),
    coldSpawns: spawns.filter((s) => s.ws === bench.cold).length,
  },
  host: {
    listTaskListCount: count('window-controller.listTaskList'),
    gitRefreshCount: count('git.refresh'),
    gitRefreshDurMs: gitDurs,
    readWorkspacePresentationCount: count('zcode-session.readWorkspacePresentation'),
    agentSpawnsTotal: spawns.length,
  },
  b2: bench.phases.b2Send
    ? {
        listTaskListCount:
          rpcCalls.filter(
            (c) => c.method === 'window-controller.listTaskList' && c.t >= bench.phases.b2Send && c.t <= bench.phases.b2End,
          ).length,
        windowMs: bench.phases.b2End - bench.phases.b2Send,
        longtasks: bench.b2Longtasks ?? null,
      }
    : null,
};
writeFileSync(`/tmp/zcode-prof/metrics-${config}.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, (k, v) => (Array.isArray(v) && v.length > 8 ? v.slice(0, 8).concat(`+${v.length - 8}`) : v), 1));
