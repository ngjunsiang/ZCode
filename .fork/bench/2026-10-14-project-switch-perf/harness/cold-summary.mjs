// Final cold-run summary: per visit, time from HOVER START (user intent) to
// "presentation ready" — first host readPresentation completion for the target —
// and whether the read began before the click (pre-warm) or after.
import { readFileSync, writeFileSync } from 'node:fs';

function parse(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const evs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('[host-log]') || lines[i].includes('writing settings')) continue;
    const m = lines[i].match(/^\[2026-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}\.\d{3})\] \[pid:\d+\] \[([a-z-]+)\] (.*)/);
    if (!m) continue;
    const rest = m[3] + ' ' + lines.slice(i + 1, i + 6).map((l) => l.trim()).join(' ');
    const t = new Date(`2026-10-14T${m[1]}+08:00`).getTime();
    evs.push({ t, rest });
  }
  return evs;
}

const summary = { runs: [] };
for (const cfg of ['cold-baseline', 'cold-opt4']) {
  const met = JSON.parse(readFileSync(`/tmp/zcode-prof/metrics-cold-${cfg}.json`, 'utf8'));
  const evs = parse(`/tmp/zcode-prof/app-log-${cfg}.log`);
  for (const v of met['visits']) {
    const path = met.targets.find((t) => t.split('/').pop() === v.target);
    const inWin = (e) => e.t >= v.hoverWall - 1000 && e.t <= v.wallClick + 25000;
    const reads = evs.filter((e) => inWin(e) && e.rest.includes('workspace/readPresentation') && e.rest.includes(path));
    const dones = evs.filter((e) => inWin(e) && e.rest.includes('readPresentation 完成') && e.rest.includes(path));
    const prewarm = reads.length > 0 && reads[0].t < v.wallClick;
    const firstDone = dones.length ? dones[0].t : null;
    summary.runs.push({
      config: cfg,
      target: v.target,
      hoverToClickMs: v.hoverToClickMs,
      firstReadStartedBeforeClick: prewarm,
      firstReadOffsetFromHoverMs: reads.length ? reads[0].t - v.hoverWall : null,
      hoverToPresentationReadyMs: firstDone != null ? firstDone - v.hoverWall : null,
      triggerDeltaWallMs: v.triggerDeltaWall, // contaminated by post-kill UI stall (both configs)
      killedAgents: v.killedAgents,
      spawnedAgent: v.spawnedAgent,
    });
  }
}
writeFileSync('/tmp/zcode-prof/cold-final-summary.json', JSON.stringify(summary, null, 1));
for (const r of summary.runs) {
  console.log(
    `${r.config.padEnd(13)} ${r.target.padEnd(12)} prewarm=${r.firstReadStartedBeforeClick ? 'YES' : 'no '} read@hover+${r.firstReadOffsetFromHoverMs}ms ready@hover+${r.hoverToPresentationReadyMs}ms (dwell ${r.hoverToClickMs}ms)`,
  );
}
